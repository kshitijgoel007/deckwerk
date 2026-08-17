#!/usr/bin/env python3
"""Import a Keynote .key file into a slide-editor deck folder.

This runs entirely in Python against the on-disk format. It never asks Keynote,
PowerPoint or any Apple framework for anything, which is what lets the same
importer run on Linux where neither exists.

A .key file is a package (zip or directory) of `.iwa` streams: Snappy-framed
protobuf. `keynote-parser` supplies the decoder and Apple's generated message
schemas; everything here is the semantic layer that turns the resulting object
graph into our deck format.

The overriding design rule is that **import must never fail outright**. Every
drawable is converted inside a guard: anything unrecognised or malformed becomes
an `unsupported` placeholder that keeps its original geometry, so the slide
still lays out correctly and the gap is visible instead of silent. `--report`
prints what was skipped, which is how coverage gets measured against real decks.

Usage:
    import_keynote.py deck.key --out /path/to/output-deck
    import_keynote.py deck.key --report
"""

from __future__ import annotations

import argparse
import functools
import html
import json
import math
import os
import re
import shutil
import subprocess
import sys
import traceback
import warnings
import zipfile
from collections import Counter
from contextlib import redirect_stdout
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

warnings.simplefilter("ignore")

try:
    from keynote_parser.codec import IWAFile
except ImportError:  # pragma: no cover - environment problem, not a deck problem
    sys.stderr.write(
        "keynote-parser is not installed. Run: pip install keynote-parser\n"
    )
    raise SystemExit(2)


# Chromium cannot decode these, so they are converted to PNG on the way in.
# Without this, TIFFs pasted into a Keynote deck import as blank rectangles.
RASTER_CONVERT = {".tiff", ".tif", ".bmp", ".tga", ".heic", ".heif"}
WEB_SAFE_IMAGE = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".m4a"}
# Vector art pasted from a paper or a logo. A browser will not render these in
# an <img>, so they are rasterised on import.
PDF_EXTS = {".pdf", ".eps"}
# Keynote stores animated GIFs as movies, but a <video> cannot play a GIF —
# they have to come back out as images, where they animate natively.
ANIMATED_IMAGE_EXTS = {".gif", ".apng", ".webp"}
# Codecs Chromium can decode on both macOS and Linux. Anything else is
# transcoded on import, or it renders as a black rectangle.
WEB_SAFE_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1", "theora"}

DEFAULT_CANVAS = (1920.0, 1080.0)


@dataclass
class Report:
    """What the importer managed to do, and what it didn't."""

    slides: int = 0
    elements: int = 0
    unsupported: Counter = field(default_factory=Counter)
    converted_images: int = 0
    cropped_images: int = 0
    transcoded_videos: int = 0
    #  Text boxes whose size Keynote left to layout, and we had to estimate.
    autosized_boxes: int = 0
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "slides": self.slides,
            "elements": self.elements,
            "unsupported": dict(self.unsupported),
            "converted_images": self.converted_images,
            "cropped_images": self.cropped_images,
            "transcoded_videos": self.transcoded_videos,
            "autosized_boxes": self.autosized_boxes,
            "warnings": self.warnings[:200],
        }


class Package:
    """Read-only access to a .key package, whether zipped or a directory."""

    def __init__(self, path: Path):
        self.path = path
        self._zip: zipfile.ZipFile | None = None
        if path.is_dir():
            self.names = [
                str(p.relative_to(path)) for p in path.rglob("*") if p.is_file()
            ]
        else:
            self._zip = zipfile.ZipFile(path)
            self.names = self._zip.namelist()

    def read(self, name: str) -> bytes:
        if self._zip is not None:
            return self._zip.read(name)
        return (self.path / name).read_bytes()

    def close(self) -> None:
        if self._zip is not None:
            self._zip.close()


def load_objects(pkg: Package, report: Report) -> dict[int, Any]:
    """Decode every .iwa stream into a flat `object id -> message` table.

    A damaged stream costs us that stream's objects and nothing else; the rest
    of the deck still imports.
    """
    objects: dict[int, Any] = {}
    for name in pkg.names:
        if not name.endswith(".iwa"):
            continue
        try:
            iwa = IWAFile.from_buffer(pkg.read(name), name)
        except Exception as exc:
            report.warnings.append(f"Could not decode {name}: {exc}")
            continue
        for chunk in iwa.chunks:
            for segment in chunk.archives:
                if segment.objects:
                    objects[segment.header.identifier] = segment.objects[0]
    return objects


def type_name(obj: Any) -> str:
    return type(obj).__name__


def find_in_super_chain(obj: Any, field_name: str) -> Any | None:
    """Find a set field on an archive or any of its `super` ancestors.

    Archives bury their base classes at different depths: an image reaches
    `TSD.DrawableArchive` in one hop, a shape in two, and a placeholder wraps a
    whole `ShapeInfoArchive` before that. Walking the chain is both shorter than
    a per-type lookup table and — more importantly — it keeps working for
    archive types this importer has never seen.
    """
    current = obj
    for _ in range(8):
        if current is None:
            return None
        if _has(current, field_name):
            try:
                if current.HasField(field_name):
                    return getattr(current, field_name)
            except ValueError:
                # Not a singular message field; treat as absent.
                pass
        if _has(current, "super"):
            current = current.super
            continue
        return None
    return None


def find_geometry(obj: Any) -> Any | None:
    """Locate a drawable's geometry, wherever it sits in the class hierarchy."""
    return find_in_super_chain(obj, "geometry")


def _has(msg: Any, field_name: str) -> bool:
    try:
        return any(f.name == field_name for f in msg.DESCRIPTOR.fields)
    except AttributeError:
        return False


def _ref(msg: Any, field_name: str) -> int | None:
    """Read a TSP.Reference field as a plain object id."""
    if not _has(msg, field_name):
        return None
    try:
        if not msg.HasField(field_name):
            return None
    except ValueError:
        pass
    ident = getattr(msg, field_name).identifier
    return int(ident) if ident else None


def data_file_table(objects: dict[int, Any]) -> dict[int, str]:
    """Map data identifiers to their filenames under `Data/`.

    `PackageMetadata.datas` is the only place this mapping exists; image and
    movie archives reference data purely by id.
    """
    for obj in objects.values():
        if type_name(obj) != "PackageMetadata":
            continue
        table: dict[int, str] = {}
        for entry in obj.datas:
            if entry.identifier and entry.file_name:
                table[int(entry.identifier)] = entry.file_name
        return table
    return {}


def extract_text(objects: dict[int, Any], shape: Any) -> str:
    """Pull plain text out of a shape's storage.

    Text content is extracted separately from its paragraph styling. The
    converter later preserves the first paragraph's layout-critical face,
    size, colour, gradient and alignment; theme.css remains available for
    deliberate restyling after import.
    """
    for field_name in ("owned_storage", "deprecated_storage"):
        # Placeholders wrap a ShapeInfoArchive, so the storage reference can sit
        # one or more levels up the `super` chain rather than on the drawable.
        reference = find_in_super_chain(shape, field_name)
        if reference is None:
            continue
        storage_id = int(reference.identifier) if reference.identifier else None
        if storage_id is None or storage_id not in objects:
            continue
        storage = objects[storage_id]
        if not _has(storage, "text"):
            continue
        chunks = [t for t in storage.text if t]
        if chunks:
            return "\n".join(chunks)
    return ""


# TSP path element type enum -> (SVG command, number of points consumed).
PATH_COMMANDS = {
    1: ("M", 1),  # moveTo
    2: ("L", 1),  # lineTo
    3: ("Q", 2),  # quadCurveTo
    4: ("C", 3),  # curveTo (cubic)
    5: ("Z", 0),  # closeSubpath
}


def path_bounds(path_msg: Any) -> tuple[float, float, float, float]:
    """Minimum and maximum coordinates of a path.

    Keynote's `naturalSize` on a path source is *not* reliably the size of the
    path it accompanies — for outline boxes it is routinely smaller. Using it as
    the SVG viewBox scales the drawing up, so the border lands well outside the
    element's box even though the box itself is correct. Measuring the path is
    the only trustworthy answer.
    """
    xs: list[float] = []
    ys: list[float] = []
    for element in path_msg.elements:
        for point in element.points:
            xs.append(float(point.x))
            ys.append(float(point.y))
    if not xs:
        return 0.0, 0.0, 0.0, 0.0
    return min(xs), min(ys), max(xs), max(ys)


def path_to_svg(path_msg: Any) -> str:
    """Convert a TSP bezier path into SVG path data.

    Keeping the real curve is what separates an imported connector arrow that
    still points at the right thing from a rectangle where an arrow used to be.
    """
    parts: list[str] = []
    for element in path_msg.elements:
        command = PATH_COMMANDS.get(int(element.type))
        if command is None:
            continue
        letter, count = command
        if count == 0:
            parts.append(letter)
            continue
        points = list(element.points)[:count]
        if len(points) < count:
            continue
        coords = " ".join(f"{p.x:.2f} {p.y:.2f}" for p in points)
        parts.append(f"{letter} {coords}")
    return " ".join(parts)


def color_to_hex(color: Any) -> str | None:
    """TSP colour -> CSS. Returns None for fully transparent colours."""
    try:
        alpha = float(getattr(color, "a", 1.0))
        if alpha <= 0.001:
            return None
        r = int(round(max(0.0, min(1.0, float(color.r))) * 255))
        g = int(round(max(0.0, min(1.0, float(color.g))) * 255))
        b = int(round(max(0.0, min(1.0, float(color.b))) * 255))
    except (AttributeError, TypeError, ValueError):
        return None
    if alpha >= 0.999:
        return f"#{r:02x}{g:02x}{b:02x}"
    return f"rgba({r}, {g}, {b}, {alpha:.3f})"


def gradient_to_css(gradient: Any) -> str | None:
    """Convert a Keynote text gradient to a CSS linear gradient."""
    stops: list[str] = []
    try:
        for stop in gradient.stops:
            colour = color_to_hex(stop.color)
            if colour:
                stops.append(f"{colour} {float(stop.fraction) * 100:.2f}%")
    except (AttributeError, TypeError, ValueError):
        return None
    if len(stops) < 2:
        return None

    # Keynote stores the angle in radians from the horizontal axis; CSS uses
    # clockwise degrees from vertical, hence the quarter-turn offset.
    angle = 90.0
    try:
        if gradient.HasField("anglegradient"):
            angle += math.degrees(float(gradient.anglegradient.gradientangle))
    except (AttributeError, TypeError, ValueError):
        pass
    return f"linear-gradient({angle:.2f}deg, {', '.join(stops)})"


@dataclass
class ShapeStyle:
    stroke: str | None = None
    stroke_width: float = 1.0
    fill: str | None = None
    arrow_start: bool = False
    arrow_end: bool = False
    # How far up the style chain the stroke came from. 0 means the object's own
    # style declared it; anything higher is a theme default, which Keynote very
    # often does not actually draw.
    stroke_depth: int = -1


def resolve_shape_style(objects: dict[int, Any], style_id: int | None) -> ShapeStyle:
    """Resolve stroke, fill and line ends through the style inheritance chain.

    Keynote stores an object's style as a thin variation that overrides only
    what differs, delegating the rest to a parent style. Reading just the leaf
    yields almost nothing, so this walks up until each property is found.
    """
    out = ShapeStyle()
    seen: set[int] = set()
    current_id = style_id
    depth = 0
    # Presence is tracked separately from value. A variation that sets `stroke`
    # to an empty message means "explicitly no stroke", and must stop the search
    # rather than fall through and inherit the parent's stroke — otherwise every
    # borderless text box imports with the theme's outline drawn around it.
    stroke_resolved = False
    fill_resolved = False
    head_resolved = False
    tail_resolved = False

    while current_id is not None and current_id in objects and depth < 8:
        if current_id in seen:  # defensive: styles should not cycle
            break
        seen.add(current_id)
        style = objects[current_id]
        depth += 1

        try:
            props = style.super.shape_properties
        except AttributeError:
            break

        if not stroke_resolved and props.HasField("stroke"):
            stroke_resolved = True
            stroke = props.stroke
            # A stroke with no colour, or with Keynote's explicit empty
            # pattern, is a deliberate "none". Text-box styles commonly carry
            # a black colour together with that empty pattern; ignoring the
            # pattern puts a phantom outline around every label.
            draws = True
            try:
                draws = not (
                    stroke.HasField("pattern") and int(stroke.pattern.type) == 2
                )
            except (AttributeError, TypeError, ValueError):
                pass
            if draws and stroke.HasField("color"):
                out.stroke_depth = depth - 1
                out.stroke = color_to_hex(stroke.color)
                width = float(getattr(stroke, "width", 0.0) or 0.0)
                if width > 0:
                    out.stroke_width = width
        if not fill_resolved and props.HasField("fill"):
            fill_resolved = True
            fill = props.fill
            # Only flat colour fills are carried across; gradients and image
            # fills would need a paint model we do not have yet.
            if fill.HasField("color"):
                out.fill = color_to_hex(fill.color)
        # A line end is only an arrowhead when it actually draws something.
        # Keynote themes define both ends as empty placeholders, so testing
        # mere presence puts an arrowhead on both ends of every line.
        if not head_resolved and props.HasField("head_line_end"):
            head_resolved = True
            out.arrow_end = _line_end_draws(props.head_line_end)
        if not tail_resolved and props.HasField("tail_line_end"):
            tail_resolved = True
            out.arrow_start = _line_end_draws(props.tail_line_end)

        try:
            parent = style.super.super.parent
            current_id = int(parent.identifier) if parent.identifier else None
        except AttributeError:
            current_id = None

    return out


# TSWP paragraph alignment enum.
ALIGNMENT_NAMES = {
    0: "left",
    1: "right",
    2: "center",
    3: "justify",
    4: "left",  # "natural" — left for the languages this tool targets
}


@dataclass
class TextStyle:
    """The few text properties worth carrying across from Keynote.

    Font face, size, alignment and paint are kept because without them text is
    not merely styled differently — it wraps, moves, or becomes invisible.
    """

    font_size: float | None = None
    font_name: str | None = None
    bold: bool | None = None
    align: str = "left"
    valign: str = "middle"
    color: str | None = None
    gradient: str | None = None
    horizontal_padding: float = 8.0


def resolve_text_style(objects: dict[int, Any], shape: Any) -> TextStyle:
    """Read font size and paragraph alignment from a shape's first paragraph.

    The first paragraph supplies the layout-critical face, size, alignment and
    paint. A user can still remove those inline values to hand control back to
    theme.css after import.
    """
    out = TextStyle(
        valign=_resolve_text_valign(objects, shape),
        horizontal_padding=_resolve_text_horizontal_padding(objects, shape),
    )
    for field_name in ("owned_storage", "deprecated_storage"):
        reference = find_in_super_chain(shape, field_name)
        if reference is None:
            continue
        storage = objects.get(int(reference.identifier) if reference.identifier else -1)
        if storage is None or not _has(storage, "table_para_style"):
            continue

        # A colour or face changed on *selected text* lands in the character
        # style table, overriding whatever the paragraph style still says —
        # recolouring a label leaves the old colour behind in the paragraph
        # style. Read the first run's own character properties before the
        # paragraph chain so the label imports in the colour Keynote shows.
        # Only the leaf is read: its parents are theme-wide defaults, which
        # must not outrank the paragraph style's explicit values.
        if _has(storage, "table_char_style"):
            for entry in storage.table_char_style.entries:
                style_id = int(entry.object.identifier) if entry.object.identifier else -1
                leaf = objects.get(style_id)
                if leaf is not None and _has(leaf, "char_properties"):
                    _read_char_properties(leaf.char_properties, out)
                break

        for entry in storage.table_para_style.entries:
            style_id = int(entry.object.identifier) if entry.object.identifier else -1
            _read_para_style(objects, style_id, out)
            # The first paragraph sets the tone for the box; later ones vary and
            # we have one size and alignment per element to give.
            if out.font_size is not None:
                break
        if out.font_size is not None:
            return out
    return out


def _resolve_text_valign(objects: dict[int, Any], shape: Any) -> str:
    """Resolve a text shape's vertical anchor from its shape style."""
    style_ref = find_in_super_chain(shape, "style")
    current_id = (
        int(style_ref.identifier)
        if style_ref is not None and style_ref.identifier
        else None
    )
    seen: set[int] = set()
    for _ in range(8):
        if current_id is None or current_id not in objects or current_id in seen:
            break
        seen.add(current_id)
        style = objects[current_id]
        if _has(style, "shape_properties"):
            props = style.shape_properties
            if props.HasField("vertical_alignment"):
                return {0: "top", 1: "middle", 2: "bottom"}.get(
                    int(props.vertical_alignment), "middle"
                )
        try:
            parent = style.super.super.parent
            current_id = int(parent.identifier) if parent.identifier else None
        except AttributeError:
            break
    return "middle"


def _resolve_text_horizontal_padding(objects: dict[int, Any], shape: Any) -> float:
    """Resolve the left+right inset used by Keynote's text layout."""
    style_ref = find_in_super_chain(shape, "style")
    current_id = int(style_ref.identifier) if style_ref is not None and style_ref.identifier else None
    seen: set[int] = set()
    for _ in range(8):
        if current_id is None or current_id not in objects or current_id in seen:
            break
        seen.add(current_id)
        style = objects[current_id]
        if _has(style, "shape_properties"):
            props = style.shape_properties
            if props.HasField("padding"):
                return float(props.padding.left) + float(props.padding.right)
        try:
            parent = style.super.super.parent
            current_id = int(parent.identifier) if parent.identifier else None
        except AttributeError:
            break
    return 8.0


def _read_char_properties(chars: Any, out: TextStyle) -> None:
    """Fill any unset character-level fields of `out` from a properties message."""
    if out.font_size is None and chars.HasField("font_size"):
        size = float(chars.font_size)
        if size > 0:
            out.font_size = size
    if out.font_name is None and chars.HasField("font_name"):
        out.font_name = str(chars.font_name) or None
    if out.bold is None and chars.HasField("bold"):
        out.bold = bool(chars.bold)
    if out.color is None and chars.HasField("font_color"):
        out.color = color_to_hex(chars.font_color)
    if out.gradient is None and chars.HasField("tsd_fill"):
        fill = chars.tsd_fill
        if fill.HasField("gradient"):
            out.gradient = gradient_to_css(fill.gradient)


def _read_para_style(objects: dict[int, Any], style_id: int, out: TextStyle) -> None:
    """Fill in size, colour and alignment, following the style's parent chain.

    Paragraph styles inherit exactly as shape styles do: a paragraph's own style
    is a thin variation that names only what differs. Reading just the leaf
    means alignment usually comes back unset and everything defaults to
    left-aligned — which is what pushed centred titles to the left margin, and
    off the slide where the box started at a negative x.
    """
    seen: set[int] = set()
    align_found = False
    current_id: int | None = style_id

    for _ in range(8):
        if current_id is None or current_id not in objects or current_id in seen:
            return
        seen.add(current_id)
        style = objects[current_id]

        if _has(style, "char_properties"):
            _read_char_properties(style.char_properties, out)

        if not align_found and _has(style, "para_properties"):
            paras = style.para_properties
            if paras.HasField("alignment"):
                # The enum serialises as a name like "TATvalue2".
                digits = "".join(c for c in str(paras.alignment) if c.isdigit())
                if digits:
                    out.align = ALIGNMENT_NAMES.get(int(digits), "left")
                    align_found = True

        if (
            out.font_size is not None
            and (out.color is not None or out.gradient is not None)
            and align_found
        ):
            return
        try:
            parent = style.super.parent
            current_id = int(parent.identifier) if parent.identifier else None
        except AttributeError:
            return


def _normalise_breaks(text: str) -> str:
    """All of Keynote's line-break characters, folded to \n.

    Keynote uses \n for paragraphs, \v for soft wraps, and U+2028/U+2029
    (LINE/PARAGRAPH SEPARATOR) for shift-return breaks. Missing the Unicode
    pair made a two-line label measure as one enormous line: its box came out
    wildly wide (overlapping neighbours) while other labels wrapped into
    one-character-wide columns.
    """
    return text.replace("\v", "\n").replace("\u2028", "\n").replace("\u2029", "\n")


def text_to_html(text: str) -> str:
    """Escape imported text, then map Keynote's paragraph breaks onto markup."""
    escaped = html.escape(_normalise_breaks(text))
    paragraphs = [p for p in escaped.split("\n")]
    while paragraphs and not paragraphs[-1].strip():
        paragraphs.pop()
    return "<br>".join(paragraphs)


def _font_family_css(font_name: str) -> str:
    """CSS fallback list for a Keynote PostScript font name."""
    escaped = font_name.replace("\\", "\\\\").replace('"', '\\"')
    friendly = {
        "HelveticaNeue-Light": "Helvetica Neue",
        "HelveticaNeue": "Helvetica Neue",
        "Helvetica-Light": "Helvetica",
        "Avenir-Book": "Avenir",
        # Keynote records the PostScript name. Browsers do not consistently
        # accept it as a CSS family name, even when Times New Roman is
        # installed, and silently substitute a much wider sans-serif face.
        "TimesNewRomanPSMT": "Times New Roman",
        "TimesNewRomanPS-BoldMT": "Times New Roman",
        "TimesNewRomanPS-ItalicMT": "Times New Roman",
        "TimesNewRomanPS-BoldItalicMT": "Times New Roman",
    }.get(font_name)
    if friendly:
        generic = "serif" if friendly == "Times New Roman" else "sans-serif"
        return f'"{escaped}", "{friendly}", {generic}'
    return f'"{escaped}", sans-serif'


@dataclass
class Importer:
    objects: dict[int, Any]
    datas: dict[int, str]
    pkg: Package
    out_dir: Path
    report: Report
    canvas: tuple[float, float] = DEFAULT_CANVAS
    #  --report analyses coverage without touching the filesystem.
    dry_run: bool = False
    _asset_cache: dict[int, str | None] = field(default_factory=dict)
    _counter: int = 0

    def next_id(self, prefix: str) -> str:
        self._counter += 1
        return f"{prefix}-{self._counter}"

    # --- assets -------------------------------------------------------------

    def copy_data(self, data_id: int | None) -> str | None:
        """Copy a referenced data file into `assets/`, converting if necessary.

        Returns a deck-relative path, or None if the file could not be found or
        used. Results are cached because one image is often reused across slides.
        """
        if data_id is None:
            return None
        if data_id in self._asset_cache:
            return self._asset_cache[data_id]

        self._asset_cache[data_id] = None
        file_name = self.datas.get(data_id)
        if not file_name:
            self.report.warnings.append(f"No filename for data id {data_id}")
            return None

        source = f"Data/{file_name}"
        if source not in self.pkg.names:
            self.report.warnings.append(f"Missing from package: {source}")
            return None

        ext = Path(file_name).suffix.lower()

        if self.dry_run:
            # Resolve the name so the report reflects what a real import would
            # produce, but write nothing.
            name = _safe_name(file_name)
            if ext in RASTER_CONVERT:
                name = _safe_name(Path(file_name).stem) + ".png"
                self.report.converted_images += 1
            rel = f"assets/{name}"
            self._asset_cache[data_id] = rel
            return rel

        assets = self.out_dir / "assets"
        assets.mkdir(parents=True, exist_ok=True)

        try:
            raw = self.pkg.read(source)
        except Exception as exc:
            self.report.warnings.append(f"Could not read {source}: {exc}")
            return None

        if ext in PDF_EXTS:
            converted = self._rasterise_pdf(raw, file_name, assets)
            self._asset_cache[data_id] = converted
            return converted

        if ext in RASTER_CONVERT:
            converted = self._convert_image(raw, file_name, assets)
            self._asset_cache[data_id] = converted
            return converted

        if ext in VIDEO_EXTS:
            playable = self._ensure_playable_video(raw, file_name, assets)
            self._asset_cache[data_id] = playable
            return playable

        if ext not in WEB_SAFE_IMAGE and ext not in VIDEO_EXTS:
            self.report.warnings.append(f"Unrecognised media type kept as-is: {file_name}")

        dest = assets / _safe_name(file_name)
        if not dest.exists():
            dest.write_bytes(raw)
        rel = f"assets/{dest.name}"
        self._asset_cache[data_id] = rel
        return rel

    def _ensure_playable_video(
        self, raw: bytes, file_name: str, assets: Path
    ) -> str | None:
        """Write a video out, transcoding it if a browser cannot decode it.

        Keynote happily embeds codecs Chromium has no decoder for — MPEG-4
        Part 2 is common in older decks — and those import as a black rectangle
        with an "Unsupported pixel format" error in the console. Anything
        outside the web-safe set is re-encoded to H.264, which is the one
        combination that plays identically on macOS and Linux.

        This is a *compatibility* transcode, unrelated to trimming: cropping and
        trimming stay non-destructive and CSS-based.
        """
        dest = assets / _safe_name(file_name)
        if not dest.exists():
            dest.write_bytes(raw)

        codec = _video_codec(dest)
        if codec is None or codec in WEB_SAFE_VIDEO_CODECS:
            return f"assets/{dest.name}"

        target = assets / (_safe_name(Path(file_name).stem) + ".h264.mp4")
        if target.exists():
            dest.unlink(missing_ok=True)
            return f"assets/{target.name}"

        if shutil.which("ffmpeg") is None:
            self.report.warnings.append(
                f"{file_name} uses the '{codec}' codec, which browsers cannot play, "
                "and ffmpeg was not found to convert it."
            )
            self.report.unsupported[f"video codec {codec}"] += 1
            return f"assets/{dest.name}"

        try:
            subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(dest),
                    "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart",
                    str(target),
                ],
                check=True,
                capture_output=True,
                timeout=600,
            )
        except Exception as exc:
            self.report.warnings.append(f"Could not transcode {file_name}: {exc}")
            self.report.unsupported[f"video codec {codec}"] += 1
            return f"assets/{dest.name}"

        # The original is unplayable and only wastes space in the deck folder.
        dest.unlink(missing_ok=True)
        self.report.transcoded_videos += 1
        return f"assets/{target.name}"

    def _rasterise_pdf(self, raw: bytes, file_name: str, assets: Path) -> str | None:
        """Render a PDF's first page to PNG.

        Logos and vector figures are routinely pasted into Keynote as PDF. A
        browser will not display one in an `<img>`, so left alone it imports as
        a broken image. Rendered at 2x so it stays sharp on a projector.
        """
        try:
            import fitz  # PyMuPDF
        except ImportError:
            self.report.warnings.append(
                f"{file_name} is a PDF and PyMuPDF is not installed, so it "
                "cannot be displayed. Install with: pip install pymupdf"
            )
            self.report.unsupported["PDF (no rasteriser)"] += 1
            return None

        try:
            with fitz.open(stream=raw, filetype="pdf") as doc:
                if doc.page_count == 0:
                    return None
                pixmap = doc.load_page(0).get_pixmap(matrix=fitz.Matrix(2, 2), alpha=True)
                dest = assets / (_safe_name(Path(file_name).stem) + ".png")
                pixmap.save(dest)
        except Exception as exc:
            self.report.warnings.append(f"Could not rasterise {file_name}: {exc}")
            return None

        self.report.converted_images += 1
        return f"assets/{dest.name}"

    def _convert_image(self, raw: bytes, file_name: str, assets: Path) -> str | None:
        """Re-encode a format Chromium cannot display as PNG."""
        import io

        try:
            from PIL import Image
        except ImportError:
            self.report.warnings.append(
                f"Pillow unavailable; {file_name} kept in an unplayable format"
            )
            dest = assets / _safe_name(file_name)
            dest.write_bytes(raw)
            return f"assets/{dest.name}"

        try:
            with Image.open(io.BytesIO(raw)) as img:
                if img.mode not in ("RGB", "RGBA"):
                    img = img.convert("RGBA")
                dest = assets / (_safe_name(Path(file_name).stem) + ".png")
                img.save(dest, "PNG")
        except Exception as exc:
            self.report.warnings.append(f"Could not convert {file_name}: {exc}")
            dest = assets / _safe_name(file_name)
            dest.write_bytes(raw)
            return f"assets/{dest.name}"

        self.report.converted_images += 1
        return f"assets/{dest.name}"

    # --- drawables ----------------------------------------------------------

    def convert_drawable(
        self,
        obj_id: int,
        z: int,
        offset: tuple[float, float] = (0.0, 0.0),
    ) -> list[dict[str, Any]]:
        """Convert one drawable, never raising.

        Groups expand into their flattened children; everything else yields at
        most one element. Any failure degrades to a placeholder rather than
        aborting the slide.
        """
        obj = self.objects.get(obj_id)
        if obj is None:
            self.report.unsupported["<missing object>"] += 1
            return []

        kind = type_name(obj)
        try:
            geometry = find_geometry(obj)
            box = self._box(geometry, offset)

            if kind == "GroupArchive":
                return self._convert_group(obj, z, box)
            if kind == "MovieArchive":
                return self._wrap(self._convert_movie(obj, box, z), kind, box, z)
            if kind == "ImageArchive":
                return self._wrap(self._convert_image_el(obj, box, z), kind, box, z)
            if kind in ("ShapeInfoArchive", "PlaceholderArchive", "ConnectionLineArchive"):
                return self._convert_shape(obj, box, z)

            self.report.unsupported[kind] += 1
            return [self._placeholder(box, z, kind, "")]
        except Exception as exc:
            self.report.unsupported[f"{kind} (error)"] += 1
            self.report.warnings.append(
                f"{kind} {obj_id} failed: {exc.__class__.__name__}: {exc}"
            )
            return [self._placeholder(self._box(None, offset), z, kind, str(exc)[:120])]

    def _wrap(
        self,
        element: dict[str, Any] | None,
        kind: str,
        box: dict[str, float],
        z: int,
    ) -> list[dict[str, Any]]:
        """An empty conversion (a text box with no text, say) contributes nothing."""
        if element is None:
            return []
        return [element]

    def _box(
        self, geometry: Any | None, offset: tuple[float, float]
    ) -> dict[str, float]:
        """Geometry -> canvas rect, translated by any enclosing group's origin."""
        if geometry is None:
            return {"x": offset[0], "y": offset[1], "w": 200.0, "h": 100.0, "rot": 0.0}
        pos = geometry.position
        size = geometry.size
        return {
            "x": float(pos.x) + offset[0],
            "y": float(pos.y) + offset[1],
            "w": max(1.0, float(size.width)),
            "h": max(1.0, float(size.height)),
            # Keynote measures rotation anticlockwise; CSS goes the other way.
            "rot": _normalise_angle(-float(getattr(geometry, "angle", 0.0) or 0.0)),
        }

    def _convert_group(
        self, obj: Any, z: int, box: dict[str, float]
    ) -> list[dict[str, Any]]:
        """Flatten a group, composing its origin into each child's position.

        v1 models no group container, so children are lifted to slide level.
        Group *rotation* is not composed — a rotated group would need a full
        transform stack — and is reported rather than silently mis-placed.
        """
        if abs(box["rot"]) > 0.01:
            self.report.warnings.append(
                "Rotated group flattened; child rotation may be wrong"
            )
        out: list[dict[str, Any]] = []
        for i, child in enumerate(obj.children):
            out.extend(
                self.convert_drawable(
                    int(child.identifier), z + i, (box["x"], box["y"])
                )
            )
        # Keynote diagrams commonly store nodes before their connecting lines,
        # but mask each connector below the filled node at paint time. Once the
        # group is flattened, reproduce that semantic layering: a native line
        # whose endpoint lies inside a filled sibling is a connector and paints
        # first. Ordinary decorative lines keep their archive order.
        connectors = [el for el in out if _is_node_connector(el, out)]
        if not connectors:
            return out
        connector_ids = {id(el) for el in connectors}
        return connectors + [el for el in out if id(el) not in connector_ids]

    def _convert_movie(
        self, obj: Any, box: dict[str, float], z: int
    ) -> dict[str, Any] | None:
        src = self.copy_data(_ref(obj, "movieData"))
        if src is None:
            self.report.unsupported["MovieArchive (no data)"] += 1
            return self._placeholder(box, z, "MovieArchive", "movie data missing")

        # Keynote wraps an animated GIF in a movie archive, but a <video> cannot
        # decode one. Emitted as an image instead, where it animates by itself.
        if Path(src).suffix.lower() in ANIMATED_IMAGE_EXTS:
            element = self._base(box, z, "image")
            element.update(
                {"src": src, "fit": "fill", "alt": "", "sourceBox": None}
            )
            return element

        start = float(getattr(obj, "startTime", 0.0) or 0.0)
        end = float(getattr(obj, "endTime", 0.0) or 0.0)

        element = self._base(box, z, "video")
        element.update(
            {
                "src": src,
                "fit": "contain",
                # Autoplay and loop regardless of what Keynote recorded. This is
                # the deck-wide default for any video in this tool, and applying
                # it on import keeps an imported clip behaving like a dropped
                # one. Keynote's own flags are frequently "play on click, once",
                # which for a short result clip means a dead frame on screen.
                # Both are per-element toggles in the inspector.
                "autoplay": True,
                "loop": True,
                "muted": True,
                "controls": False,
                "start": start if start > 0 else 0,
                "end": end if end > start else None,
                "poster": None,
            }
        )
        return element

    def _convert_image_el(
        self, obj: Any, box: dict[str, float], z: int
    ) -> dict[str, Any] | None:
        src = self.copy_data(_ref(obj, "data"))
        if src is None:
            self.report.unsupported["ImageArchive (no data)"] += 1
            return self._placeholder(box, z, "ImageArchive", "image data missing")

        description = ""
        try:
            description = obj.super.accessibility_description or ""
        except AttributeError:
            pass

        # A cropped image in Keynote is the *whole* image, positioned so that
        # the interesting part falls inside a separate mask rectangle. The
        # drawable's own geometry is therefore the full image — frequently many
        # times the size of the slide and anchored off-canvas — and using it as
        # the element box puts a giant, wrongly-placed picture on the slide.
        # The visible box is the mask; the image is then offset inside it.
        mask_geometry = self._mask_geometry(obj)
        source_box = None
        if mask_geometry is not None:
            visible = {
                # Mask position is relative to the image's own origin.
                "x": box["x"] + float(mask_geometry.position.x),
                "y": box["y"] + float(mask_geometry.position.y),
                "w": max(1.0, float(mask_geometry.size.width)),
                "h": max(1.0, float(mask_geometry.size.height)),
                "rot": box["rot"],
            }
            self.report.cropped_images += 1
            source_box = {
                "x": round(box["x"] - visible["x"], 2),
                "y": round(box["y"] - visible["y"], 2),
                "w": round(box["w"], 2),
                "h": round(box["h"], 2),
            }
            box = visible

        element = self._base(box, z, "image")
        element.update(
            {
                "src": src,
                # 'fill' matches Keynote's displayed box exactly for uncropped
                # images; a cropped one is placed by sourceBox instead.
                "fit": "fill",
                "alt": description,
                "sourceBox": source_box,
            }
        )
        return element

    def _mask_geometry(self, obj: Any) -> Any | None:
        """Geometry of an image's mask, if it is cropped."""
        mask_id = _ref(obj, "mask")
        if mask_id is None or mask_id not in self.objects:
            return None
        geometry = find_geometry(self.objects[mask_id])
        if geometry is None:
            return None
        if geometry.size.width <= 0 or geometry.size.height <= 0:
            return None
        return geometry

    def _convert_shape(
        self, obj: Any, box: dict[str, float], z: int
    ) -> list[dict[str, Any]]:
        """Convert a Keynote shape, including both paint and text when present."""
        out: list[dict[str, Any]] = []

        text = extract_text(self.objects, obj)

        # An empty text box keeps its place with placeholder text, the way
        # Keynote shows one. Dropping it would lose a deliberate slot in the
        # layout; importing it as a zero-height shape would leave an invisible
        # sliver that cannot be selected.
        if not text.strip() and _is_text_box(obj):
            style = resolve_text_style(self.objects, obj)
            font_size = style.font_size or DEFAULT_FONT_SIZE
            box = self._size_text_box(
                box,
                PLACEHOLDER_TEXT,
                font_size,
                style.align,
                style.valign,
                self._text_natural_size(obj),
                style.font_name,
                bool(style.bold),
                style.horizontal_padding,
            )
            element = self._base(box, z, "text")
            inline = {"font-size": f"{font_size:.0f}px"}
            if style.font_name:
                inline["font-family"] = _font_family_css(style.font_name)
            element.update(
                {
                    "html": PLACEHOLDER_TEXT,
                    "autoFit": True,
                    "align": style.align,
                    "valign": style.valign,
                    "class": ["kn-text", "placeholder"],
                    "style": inline,
                }
            )
            out.append(element)
            return out

        # Some Keynote shapes are genuinely both: slide 19's white, black-
        # bordered conviction box also owns its caption text. Empty-pattern
        # strokes were filtered while resolving the style, so ordinary text
        # boxes still do not acquire phantom borders here.
        vector = self._convert_vector(obj, box, z)
        if vector is not None:
            out.append(vector)

        if text.strip():
            style = resolve_text_style(self.objects, obj)
            font_size = style.font_size or DEFAULT_FONT_SIZE
            box = self._size_text_box(
                box,
                text,
                font_size,
                style.align,
                style.valign,
                self._text_natural_size(obj),
                style.font_name,
                bool(style.bold),
                style.horizontal_padding,
            )

            # Layout-critical Keynote typography keeps wrapping and light-on-
            # dark labels faithful. Deleting these inline values hands control
            # back to theme.css.
            inline = {"font-size": f"{font_size:.0f}px"}
            if style.font_name:
                inline["font-family"] = _font_family_css(style.font_name)
            if style.bold:
                inline["font-weight"] = "700"
            elif style.font_name and "light" in style.font_name.lower():
                inline["font-weight"] = "300"
            if style.gradient:
                inline.update(
                    {
                        "background-image": style.gradient,
                        "background-clip": "text",
                        "-webkit-background-clip": "text",
                        "color": "transparent",
                    }
                )
            elif style.color:
                inline["color"] = style.color

            element = self._base(box, z, "text")
            element.update(
                {
                    "html": text_to_html(text),
                    "autoFit": True,
                    "align": style.align,
                    "valign": style.valign,
                    "class": ["kn-text"],
                    "style": inline,
                }
            )
            out.append(element)

        return out

    def _size_text_box(
        self,
        box: dict[str, float],
        text: str,
        font_size: float,
        align: str,
        valign: str,
        natural_size: tuple[float, float] | None,
        font_name: str | None = None,
        bold: bool = False,
        horizontal_padding: float = 8.0,
    ) -> dict[str, float]:
        """Give an auto-sizing text box a real width and height.

        Keynote stores a text box that sizes itself to its content with a
        width and/or height of zero, and computes the real extent at layout
        time from the font metrics. Taken literally that produces a 1px-wide
        box, which renders as a column of single characters — the "vertical
        text" failure.

        The path source normally carries Keynote's computed ``naturalSize``,
        which is the exact result of its font layout. Character-count estimates
        are only a fallback for older files that omit that cache.

        Rotated boxes store their position under a different convention (see
        the quarter-turn handling below), verified against the hand-authored
        vertical labels on reference.key slide 25.
        """
        out = dict(box)
        lines = _normalise_breaks(text).split("\n")
        longest = max((len(line) for line in lines), default=1)
        width_was_auto = out["w"] <= 1
        height_was_auto = out["h"] <= 1
        rot = _normalise_angle(float(out.get("rot", 0.0) or 0.0))
        # Vertical text: Keynote's anchor conventions for auto-sized geometry
        # change once a box is turned on its side.
        quarter_turn = abs(abs(rot) - 90.0) < 2.0

        if width_was_auto:
            measured = _measure_text_width(
                text, font_size, font_name, bold, horizontal_padding
            )
            if measured is not None:
                out["w"] = measured
            elif natural_size is not None and natural_size[0] > 1:
                out["w"] = natural_size[0]
            else:
                # 0.48em is a conservative mean for display faces.
                estimated = longest * font_size * 0.48
                out["w"] = max(200.0, min(estimated, self.canvas[0] - 40))

            # Auto-width geometry stores the alignment anchor, not always the
            # left edge: centred labels use their horizontal centre and
            # right-aligned labels use their right edge. Fully-auto rotated
            # boxes are anchored differently and handled below instead.
            if not (quarter_turn and height_was_auto):
                if align == "center":
                    out["x"] -= out["w"] / 2
                elif align == "right":
                    out["x"] -= out["w"]
            self.report.autosized_boxes += 1

        if out["h"] <= 1:
            centre_y = out["y"]
            if natural_size is not None and natural_size[1] > 1:
                out["h"] = natural_size[1]
            else:
                # Auto-width text is laid out as its explicit lines; a fixed
                # width can introduce additional soft wrapping.
                if width_was_auto:
                    wrapped = len(lines)
                else:
                    per_line = max(1.0, out["w"] / max(1.0, font_size * 0.48))
                    wrapped = sum(max(1, math.ceil(len(line) / per_line)) for line in lines)
                estimated = max(font_size * 1.3, wrapped * font_size * 1.3)
                room = max(font_size * 1.3, self.canvas[1] - out["y"])
                out["h"] = min(estimated, room)
            # Auto-height geometry stores the vertical alignment anchor: top,
            # centre, or bottom depending on the shape style. Rotated boxes
            # use their own anchors, applied below.
            if not quarter_turn:
                if valign == "middle":
                    out["y"] = centre_y - out["h"] / 2
                elif valign == "bottom":
                    out["y"] = centre_y - out["h"]
            self.report.autosized_boxes += 1

        # Quarter-turned text stores its position under conventions of its own,
        # reverse-engineered from the hand-authored vertical labels on
        # reference.key slide 25 (all rotated 90° anticlockwise):
        #
        #  * both dimensions auto: the stored position is where the *unrotated
        #    frame's top-left corner* lands after rotating about the frame's
        #    centre. Solved generally below, so it also reduces to the plain
        #    top-left at rot 0.
        #  * fixed width, auto height: the stored position is the frame's
        #    top-left displaced by (h/2, h/2) — h being the laid-out height —
        #    independent of the shape's valign (slide 25's labels carry
        #    valign bottom yet anchor at h/2). Only observed at 90°
        #    anticlockwise; assumed symmetric for clockwise.
        if quarter_turn and width_was_auto and height_was_auto:
            theta = math.radians(rot)
            corner_dx = (-out["w"] / 2) * math.cos(theta) - (-out["h"] / 2) * math.sin(theta)
            corner_dy = (-out["w"] / 2) * math.sin(theta) + (-out["h"] / 2) * math.cos(theta)
            out["x"] = box["x"] - corner_dx - out["w"] / 2
            out["y"] = box["y"] - corner_dy - out["h"] / 2
        elif quarter_turn and not width_was_auto and height_was_auto:
            out["x"] -= out["h"] / 2
            out["y"] -= out["h"] / 2

        # A rotated frame legitimately extends past the canvas while its
        # visible extent stays on the slide — clamping the unrotated frame
        # would shear the box sideways (it truncated the slide-25 "Robotics"
        # label to two thirds of its width). The selection outline follows the
        # rotation in the editor, so oversized handles are not a concern here.
        if abs(rot) > 0.5:
            return out
        return self._clamp_text_box(out)

    def _clamp_text_box(self, box: dict[str, float]) -> dict[str, float]:
        """Keep imported text geometry inside the editable slide canvas.

        Keynote permits a text container to extend beyond the slide while its
        centred contents remain visible. In the editor that hidden extent
        creates enormous selection boxes and makes resize handles unreachable.
        Intersecting the container with the canvas preserves the visible area
        and turns it into an ordinary, editable text box.
        """
        out = dict(box)
        canvas_w, canvas_h = self.canvas
        right = min(canvas_w, max(0.0, out["x"] + out["w"]))
        bottom = min(canvas_h, max(0.0, out["y"] + out["h"]))
        out["x"] = min(canvas_w - 1.0, max(0.0, out["x"]))
        out["y"] = min(canvas_h - 1.0, max(0.0, out["y"]))
        out["w"] = max(1.0, right - out["x"])
        out["h"] = max(1.0, bottom - out["y"])
        return out

    def _text_natural_size(self, obj: Any) -> tuple[float, float] | None:
        """Return Keynote's cached layout size for an auto-sizing text shape."""
        pathsource = find_in_super_chain(obj, "pathsource")
        if pathsource is None:
            return None
        for field_name in (
            "bezier_path_source",
            "editable_bezier_path_source",
            "point_path_source",
            "scalar_path_source",
        ):
            if not _has(pathsource, field_name) or not pathsource.HasField(field_name):
                continue
            source = getattr(pathsource, field_name)
            base = source.super if _has(source, "super") else source
            if _has(base, "naturalSize") and base.HasField("naturalSize"):
                size = base.naturalSize
                return float(size.width), float(size.height)
        return None

    def _convert_vector(
        self, obj: Any, box: dict[str, float], z: int
    ) -> dict[str, Any] | None:
        """Extract a shape's drawn path, or None if it has no visible paint.

        A shape with neither stroke nor fill is invisible in Keynote too — these
        are layout scaffolding and text-box backing, and importing them would
        bury the real content under hundreds of empty rectangles.
        """
        pathsource = find_in_super_chain(obj, "pathsource")
        if pathsource is None:
            return None

        style_ref = find_in_super_chain(obj, "style")
        style_id = (
            int(style_ref.identifier)
            if style_ref is not None and style_ref.identifier
            else None
        )
        style = resolve_shape_style(self.objects, style_id)

        # Keynote's themes carry a default hairline black stroke that the app
        # does not actually paint on a filled shape. Honouring it puts a black
        # border around every solid box — the blue rectangles, the black
        # caption bars, and the white boxes used to mask part of a figure
        # mid-build.
        #
        # A filled shape therefore keeps its stroke only when that stroke looks
        # deliberate: set on the object's own style, and either thicker than a
        # hairline or not plain black. Every intentional outline seen so far is
        # a 6-7px colour. The known cost is that a genuinely authored 1px black
        # border on a filled shape would be dropped; that has not appeared in
        # any real deck, and a spurious border on every box is far worse.
        if style.stroke is not None and style.fill is not None:
            theme_default = style.stroke_depth > 0
            hairline_black = style.stroke_width <= 1.0 and style.stroke == "#000000"
            if theme_default or hairline_black:
                style.stroke = None

        if style.stroke is None and style.fill is None:
            return None

        # Rounded rectangles use a scalar path source with no explicit bezier
        # path. They map directly onto the editor's native rounded rectangle.
        if (
            _has(pathsource, "scalar_path_source")
            and pathsource.HasField("scalar_path_source")
        ):
            source = pathsource.scalar_path_source
            if int(source.type) == 0:
                element = self._base(box, z, "shape")
                element.update(
                    {
                        "shape": "rect",
                        "path": None,
                        "pathSize": None,
                        "fill": style.fill,
                        "stroke": style.stroke,
                        "strokeWidth": style.stroke_width,
                        "radius": max(0.0, float(source.scalar)),
                        "arrowStart": False,
                        "arrowEnd": False,
                    }
                )
                return element

        path_data = ""
        bounds = (0.0, 0.0, 0.0, 0.0)
        path_msg = None
        is_connection = False
        for field_name in (
            "bezier_path_source",
            "connection_line_path_source",
            "editable_bezier_path_source",
            "point_path_source",
            "scalar_path_source",
        ):
            if not _has(pathsource, field_name) or not pathsource.HasField(field_name):
                continue
            source = getattr(pathsource, field_name)
            # Some path sources wrap the real one in `super`.
            base = source.super if _has(source, "super") else source
            if not _has(base, "path"):
                continue
            path_msg = base.path
            path_data = path_to_svg(path_msg)
            if field_name == "connection_line_path_source":
                is_connection = True
            bounds = path_bounds(path_msg)
            break

        if not path_data:
            return None

        min_x, min_y, max_x, max_y = bounds
        path_w = max(max_x - min_x, 1.0)
        path_h = max(max_y - min_y, 1.0)

        # Connectors stay editable native lines/arrows. Curved connection lines
        # carry one native quadratic control point so their bend survives while
        # endpoints remain freely draggable in the editor.
        if is_connection and path_msg is not None:
            endpoints = _path_endpoints(path_msg)
            if endpoints is not None:
                start, end = endpoints
                sx = box["w"] / path_w
                sy = box["h"] / path_h
                start_abs = (
                    box["x"] + (start[0] - min_x) * sx,
                    box["y"] + (start[1] - min_y) * sy,
                )
                end_abs = (
                    box["x"] + (end[0] - min_x) * sx,
                    box["y"] + (end[1] - min_y) * sy,
                )
                control_abs = None
                curve = _connection_curve(path_msg)
                if curve is not None:
                    _, control, _ = curve
                    control_abs = (
                        box["x"] + (control[0] - min_x) * sx,
                        box["y"] + (control[1] - min_y) * sy,
                    )
                return self._native_line(style, start_abs, end_abs, z, control_abs)

        # The viewBox is the path's own extent, never Keynote's `naturalSize`,
        # which is unreliable in both directions and wrong in opposite ways:
        #   - outline boxes: the path is LARGER than naturalSize, so trusting it
        #     scales the drawing up and the border spills outside the element;
        #   - lines and arrows: the path is SMALLER (a 141pt stub for a 345pt
        #     line), so trusting it draws the line only part of the way across.
        # Measuring the path fixes both, because the box is then stretched to
        # exactly the element's geometry — which the reference deck confirms is
        # already correct.
        view_w = path_w
        view_h = path_h

        # Scale the path into the element's own coordinate space so the SVG
        # needs no stretching at all. Non-uniform stretching is what made
        # arrowheads long and thin: a marker on a 141x1 path blown out to
        # 345x1 is scaled 2.4x horizontally and not at all vertically.
        sx = box["w"] / view_w
        sy = box["h"] / view_h
        if (
            abs(min_x) > 0.001
            or abs(min_y) > 0.001
            or abs(sx - 1.0) > 0.001
            or abs(sy - 1.0) > 0.001
        ):
            path_data = _scale_path(path_data, sx, sy, min_x, min_y)
            view_w = max(box["w"], 1.0)
            view_h = max(box["h"], 1.0)

        # A plain two-point horizontal path is a straight line or arrow. Emit
        # it as the native shape rather than an opaque path, so the editor can
        # offer endpoint handles and the arrowhead marker is never distorted.
        simple = _simple_line(path_data)
        if simple and box["h"] <= 4:
            element = self._base(box, z, "shape")
            element.update(
                {
                    "shape": "arrow" if (style.arrow_end or style.arrow_start) else "line",
                    "path": None,
                    "pathSize": None,
                    "fill": None,
                    "stroke": style.stroke,
                    "strokeWidth": style.stroke_width,
                    "radius": 0,
                    "arrowStart": style.arrow_start,
                    "arrowEnd": style.arrow_end,
                }
            )
            return element

        element = self._base(box, z, "shape")
        element.update(
            {
                "shape": "path",
                "path": path_data,
                "pathSize": {"w": view_w, "h": view_h},
                "fill": style.fill,
                "stroke": style.stroke,
                "strokeWidth": style.stroke_width,
                "radius": 0,
                "arrowStart": style.arrow_start,
                "arrowEnd": style.arrow_end,
            }
        )
        return element

    def _native_line(
        self,
        style: ShapeStyle,
        start: tuple[float, float],
        end: tuple[float, float],
        z: int,
        control: tuple[float, float] | None = None,
    ) -> dict[str, Any]:
        """Build an editable native line/arrow from canvas-space endpoints."""
        dx = end[0] - start[0]
        dy = end[1] - start[1]
        length = max(1.0, math.hypot(dx, dy))
        height = 1.0
        centre_x = (start[0] + end[0]) / 2
        centre_y = (start[1] + end[1]) / 2
        native_box = {
            "x": centre_x - length / 2,
            "y": centre_y - height / 2,
            "w": length,
            "h": height,
            "rot": math.degrees(math.atan2(dy, dx)),
        }
        element = self._base(native_box, z, "shape")
        element.update(
            {
                "shape": "arrow" if (style.arrow_end or style.arrow_start) else "line",
                "path": None,
                "pathSize": None,
                "fill": None,
                "stroke": style.stroke,
                "strokeWidth": style.stroke_width,
                "radius": 0,
                "arrowStart": style.arrow_start,
                "arrowEnd": style.arrow_end,
                "control": (
                    {"x": round(control[0], 2), "y": round(control[1], 2)}
                    if control is not None
                    else None
                ),
            }
        )
        return element

    def _placeholder(
        self, box: dict[str, float], z: int, original: str, note: str
    ) -> dict[str, Any]:
        element = self._base(box, z, "unsupported")
        element.update(
            {
                "originalType": original,
                "note": f"{original}{': ' + note if note else ''}",
            }
        )
        return element

    def _base(self, box: dict[str, float], z: int, kind: str) -> dict[str, Any]:
        return {
            "id": self.next_id(kind),
            "type": kind,
            "x": round(box["x"], 2),
            "y": round(box["y"], 2),
            "w": round(box["w"], 2),
            "h": round(box["h"], 2),
            "rot": round(box["rot"], 2),
            "z": z,
            "opacity": 1,
            "class": [],
            "style": {},
        }

    # --- slides -------------------------------------------------------------

    def slide_background(self, slide_obj: Any) -> dict[str, Any]:
        """Resolve a slide's background colour or image.

        The background is a *fill on the slide's style*, not a drawable, and it
        is inherited: a slide's own style overrides its master's, which
        overrides the theme's. Walking only the slide's own drawables — as the
        importer originally did — loses every background, which is why decks
        with a full-bleed title image imported blank.
        """
        for source in (slide_obj, self._template_of(slide_obj)):
            if source is None:
                continue
            fill = self._resolve_slide_fill(_ref(source, "style"))
            if fill is None:
                continue
            if fill.HasField("color"):
                colour = color_to_hex(fill.color)
                if colour:
                    return {"color": colour, "image": None}
            if fill.HasField("image"):
                src = self.copy_data(_ref(fill.image, "imagedata"))
                if src:
                    return {"color": None, "image": src}
        return {"color": "#ffffff", "image": None}

    def _template_of(self, slide_obj: Any) -> Any | None:
        template_id = _ref(slide_obj, "template_slide")
        return self.objects.get(template_id) if template_id else None

    def _resolve_slide_fill(self, style_id: int | None) -> Any | None:
        """Find the first fill declared anywhere up a slide style's chain."""
        seen: set[int] = set()
        current_id = style_id
        for _ in range(8):
            if current_id is None or current_id not in self.objects or current_id in seen:
                return None
            seen.add(current_id)
            style = self.objects[current_id]
            props = getattr(style, "slide_properties", None)
            if props is not None and props.HasField("fill"):
                return props.fill
            try:
                parent = style.super.parent
                current_id = int(parent.identifier) if parent.identifier else None
            except AttributeError:
                return None
        return None

    def convert_slide(
        self, slide_obj: Any, index: int, skipped: bool = False
    ) -> dict[str, Any]:
        elements: list[dict[str, Any]] = []
        drawable_ids = [int(r.identifier) for r in slide_obj.owned_drawables]

        # `drawables_z_order` is authoritative when present; otherwise document
        # order already reflects back-to-front.
        try:
            ordered = [int(r.identifier) for r in slide_obj.drawables_z_order]
            if set(ordered) == set(drawable_ids):
                drawable_ids = ordered
        except AttributeError:
            pass

        for z, drawable_id in enumerate(drawable_ids):
            elements.extend(self.convert_drawable(drawable_id, z))

        # Flattened group children must remain one contiguous paint block.
        # ``z + child_index`` overlaps later top-level z values and interleaves
        # complex grouped drawings, which is especially visible on slide 23.
        for paint_order, element in enumerate(elements):
            element["z"] = paint_order

        name = ""
        try:
            name = slide_obj.name or ""
        except AttributeError:
            pass

        notes = self._slide_notes(slide_obj)

        slide: dict[str, Any] = {
            "id": f"slide-{index + 1}",
            "name": name or f"Slide {index + 1}",
            "background": self.slide_background(slide_obj),
            "notes": notes,
            "elements": elements,
            # Builds are not imported: Keynote's build graph does not map onto
            # our step model without guessing, and a wrong build is worse than
            # none. Everything lands visible; re-author reveals in the editor.
            "timeline": [],
        }
        if skipped:
            # Keynote's "Skip Slide": kept in the deck, stepped over on stage.
            slide["skipped"] = True
        return slide

    def _slide_notes(self, slide_obj: Any) -> str:
        note_id = _ref(slide_obj, "note")
        if note_id is None or note_id not in self.objects:
            return ""
        try:
            return extract_text(self.objects, self.objects[note_id])
        except Exception:
            return ""


"""Used when a text box has no resolvable font size — readable, not tiny."""
DEFAULT_FONT_SIZE = 36.0

"""Shown in an empty imported text box, mirroring what Keynote displays."""
PLACEHOLDER_TEXT = "Text"


def _normalise_angle(degrees: float) -> float:
    """Fold a rotation into (-180, 180].

    A 30-degree clockwise rotation reaches us as 330 anticlockwise, which
    negates to -330. That renders identically to 30, but shows up as a baffling
    "-330" in the inspector and makes reference decks hard to check by eye.
    """
    wrapped = degrees % 360.0
    if wrapped > 180.0:
        wrapped -= 360.0
    return round(wrapped, 2)


@functools.lru_cache(maxsize=128)
def _resolved_font(font_name: str, bold: bool) -> tuple[str, int] | None:
    """Find a local font file and collection index without platform APIs."""
    if not font_name or shutil.which("fc-match") is None:
        return None
    base, _, declared_style = font_name.partition("-")
    family = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", base.replace("PSMT", ""))
    style = "Bold" if bold else (declared_style or "Regular")
    try:
        match = subprocess.run(
            ["fc-match", "--format=%{file}|%{index}|%{family}", f"{family}:style={style}"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout
        path, index, matched_family = match.split("|", 2)
    except Exception:
        return None

    def compact(value: str) -> str:
        return "".join(c.lower() for c in value if c.isalnum())

    wanted = compact(family)
    found = compact(matched_family.split(",", 1)[0])
    if not wanted or (wanted not in found and found not in wanted):
        return None
    return path, int(index or 0)


def _measure_text_width(
    text: str,
    font_size: float,
    font_name: str | None,
    bold: bool,
    horizontal_padding: float,
) -> float | None:
    """Measure the longest explicit line with the actual imported font."""
    if not font_name:
        return None
    resolved = _resolved_font(font_name, bold)
    if resolved is None:
        return None
    try:
        from PIL import ImageFont

        pixel_size = max(1, round(font_size))
        font = ImageFont.truetype(resolved[0], pixel_size, index=resolved[1])
        scale = font_size / pixel_size
        lines = _normalise_breaks(text).split("\n")
        return max(float(font.getlength(line)) * scale for line in lines) + horizontal_padding
    except Exception:
        return None


def _classify_text_roles(slides: list[dict[str, Any]]) -> None:
    """Tag every text element with a semantic role class.

    Mirrors `roleForSize` in src/shared/fontSets.ts: roles are decided by each
    element's size relative to the deck's largest text, because absolute sizes
    mean nothing across decks. The classes make the "Cast fonts" button and the
    per-element role picker work on freshly imported decks.
    """
    def size_of(el: dict[str, Any]) -> float:
        try:
            return float(str(el["style"].get("font-size", "0")).rstrip("px"))
        except ValueError:
            return 0.0

    def text_len(el: dict[str, Any]) -> int:
        import re
        return len(re.sub(r"<[^>]+>", "", el.get("html", "")).strip())

    # The scale is set by real prose, not decorations: a lone 200px "+" glyph
    # between two figures would otherwise become the "title" and demote every
    # actual title to a heading.
    sizes = [
        size_of(el)
        for slide in slides
        for el in slide["elements"]
        if el["type"] == "text" and text_len(el) >= 3
    ]
    max_size = max(sizes, default=0.0)
    if max_size <= 0:
        return
    for slide in slides:
        for el in slide["elements"]:
            if el["type"] != "text":
                continue
            size = size_of(el)
            if text_len(el) < 3 and size > max_size:
                # Oversized decoration (an operator glyph, a big quote mark):
                # style it as base rather than letting it claim "title".
                el["class"] = [c for c in el["class"] if not c.startswith("role-")]
                continue
            ratio = (size or max_size * 0.5) / max_size
            if ratio >= 0.85:
                role = "title"
            elif ratio >= 0.6:
                role = "heading"
            elif ratio >= 0.38:
                role = "body"
            elif ratio <= 0.3:
                role = "caption"
            else:
                role = "base"
            el["class"] = [c for c in el["class"] if not c.startswith("role-")]
            if role != "base":
                el["class"].append(f"role-{role}")


def _simple_line(path_data: str) -> bool:
    """True for a path that is a single straight segment along y ~= 0."""
    tokens = path_data.replace(",", " ").split()
    if tokens[:1] != ["M"] or "Q" in tokens or "C" in tokens:
        return False
    nums = [t for t in tokens if t not in ("M", "L", "Z")]
    if len(nums) != 4:
        return False
    try:
        _, y0, _, y1 = (float(n) for n in nums)
    except ValueError:
        return False
    return abs(y0) <= 2 and abs(y1) <= 2


def _is_node_connector(element: dict[str, Any], siblings: list[dict[str, Any]]) -> bool:
    """Whether a native line terminates inside a filled sibling node."""
    if element.get("type") != "shape" or element.get("shape") != "line":
        return False
    cx = float(element["x"]) + float(element["w"]) / 2
    cy = float(element["y"]) + float(element["h"]) / 2
    angle = math.radians(float(element.get("rot", 0)))
    dx = math.cos(angle) * float(element["w"]) / 2
    dy = math.sin(angle) * float(element["w"]) / 2
    endpoints = ((cx - dx, cy - dy), (cx + dx, cy + dy))
    for sibling in siblings:
        if sibling is element or sibling.get("type") != "shape" or not sibling.get("fill"):
            continue
        left, top = float(sibling["x"]), float(sibling["y"])
        right = left + float(sibling["w"])
        bottom = top + float(sibling["h"])
        if any(left <= x <= right and top <= y <= bottom for x, y in endpoints):
            return True
    return False


def _connection_curve(
    path_msg: Any,
) -> tuple[
    tuple[float, float], tuple[float, float], tuple[float, float]
] | None:
    """Return start/control/end for a curved Keynote connector.

    A quadratic connection line is stored as a 3-point polyline whose middle
    point is the bezier CONTROL point — Keynote reconstructs the curve at draw
    time. (Not a point on the curve: on reference.key slide 20, reading it as
    on-curve derives controls outside the segment, one nearly coincident with
    the arrow's endpoint, which flips the arrowhead tangent and renders the
    head inverted.) Straight connectors have 2 points and are left alone.
    """
    pts: list[tuple[float, float]] = []
    start: tuple[float, float] | None = None
    for el in path_msg.elements:
        t = int(el.type)
        if t in (1, 2):
            for p in el.points:
                point = (float(p.x), float(p.y))
                if start is None:
                    start = point
                pts.append(point)
        elif t == 3 and start is not None and len(el.points) >= 2:
            control = (float(el.points[0].x), float(el.points[0].y))
            end = (float(el.points[1].x), float(el.points[1].y))
            return start, control, end
        elif t == 4 and start is not None and len(el.points) >= 3:
            p1 = (float(el.points[0].x), float(el.points[0].y))
            p2 = (float(el.points[1].x), float(el.points[1].y))
            end = (float(el.points[2].x), float(el.points[2].y))
            midpoint = (
                0.125 * start[0] + 0.375 * p1[0] + 0.375 * p2[0] + 0.125 * end[0],
                0.125 * start[1] + 0.375 * p1[1] + 0.375 * p2[1] + 0.125 * end[1],
            )
            control = (
                2 * midpoint[0] - (start[0] + end[0]) / 2,
                2 * midpoint[1] - (start[1] + end[1]) / 2,
            )
            return start, control, end
        elif t == 5:
            continue
        else:
            return None
    if len(pts) != 3:
        return None
    return pts[0], pts[1], pts[2]


def _path_endpoints(
    path_msg: Any,
) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """First and last drawn points of a Keynote path."""
    points: list[tuple[float, float]] = []
    for element in path_msg.elements:
        for point in element.points:
            points.append((float(point.x), float(point.y)))
    if len(points) < 2:
        return None
    return points[0], points[-1]


def _scale_path(
    path_data: str,
    sx: float,
    sy: float,
    origin_x: float = 0.0,
    origin_y: float = 0.0,
) -> str:
    """Translate a path to a zero origin, then scale each coordinate pair."""
    out: list[str] = []
    axis = 0
    for token in path_data.split(" "):
        if not token:
            continue
        try:
            value = float(token)
        except ValueError:
            out.append(token)
            # Commands restart the x/y alternation.
            axis = 0
            continue
        origin = origin_x if axis == 0 else origin_y
        out.append(f"{(value - origin) * (sx if axis == 0 else sy):.2f}")
        axis ^= 1
    return " ".join(out)


def _line_end_draws(line_end: Any) -> bool:
    """Whether a line end is a real arrowhead rather than an empty placeholder."""
    try:
        return len(line_end.path.elements) > 0
    except AttributeError:
        return False


def _video_codec(path: Path) -> str | None:
    """The video stream's codec name, or None if it cannot be determined."""
    if shutil.which("ffprobe") is None:
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path)],
            check=True, capture_output=True, timeout=60,
        )
        return out.stdout.decode().strip().splitlines()[0].strip() or None
    except Exception:
        return None


def _is_text_box(obj: Any) -> bool:
    """Whether a drawable is a text box rather than drawn vector art."""
    current = obj
    for _ in range(6):
        if _has(current, "is_text_box"):
            return bool(current.is_text_box)
        if _has(current, "super"):
            current = current.super
            continue
        return False
    return False


def _safe_name(name: str) -> str:
    keep = "".join(c if c.isalnum() or c in "._-" else "-" for c in name)
    return keep.strip("-") or "asset"


THEME_CSS = """/*
 * Imported from Keynote. Layout-critical text face, size and paint are kept as
 * inline values; remove them from an element to style it entirely from here.
 *
 * Imported text carries the class .kn-text and an inline font-size fitted to the
 * box it occupied in Keynote. Delete those inline sizes once you have styled
 * .kn-text the way you want.
 */

.slide {
  background: #ffffff;
  color: #111111;
  font-family: "Helvetica Neue", Inter, system-ui, sans-serif;
}

.kn-text {
  line-height: 1.2;
}

/* Semantic defaults for text boxes created after import. Imported Keynote text
 * keeps its own inline size, so these do not disturb the source slides. */
.role-title {
  font-size: 92px;
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: -0.02em;
}

.role-heading {
  font-size: 58px;
  font-weight: 600;
  line-height: 1.15;
}

.role-body {
  font-size: 44px;
  line-height: 1.3;
}

.role-caption {
  font-size: 28px;
  line-height: 1.3;
}
"""


def import_key(path: Path, out_dir: Path, write: bool) -> tuple[dict[str, Any], Report]:
    report = Report()
    pkg = Package(path)
    try:
        objects = load_objects(pkg, report)
        if not objects:
            raise SystemExit(f"No readable .iwa streams in {path}")

        datas = data_file_table(objects)
        if not datas:
            report.warnings.append(
                "No data file table found; images and movies will be missing"
            )

        show = next((o for o in objects.values() if type_name(o) == "ShowArchive"), None)
        if show is None:
            raise SystemExit(f"No ShowArchive in {path}: this may not be a Keynote file")

        canvas_w = float(getattr(show.size, "width", 0) or DEFAULT_CANVAS[0])
        canvas_h = float(getattr(show.size, "height", 0) or DEFAULT_CANVAS[1])

        importer = Importer(
            objects=objects,
            datas=datas,
            pkg=pkg,
            out_dir=out_dir,
            report=report,
            canvas=(canvas_w, canvas_h),
            dry_run=not write,
        )

        slides: list[dict[str, Any]] = []
        for index, node_ref in enumerate(show.slideTree.slides):
            try:
                node = objects[int(node_ref.identifier)]
                slide_obj = objects[int(node.slide.identifier)]
                skipped = bool(getattr(node, "isSkipped", False))
                slides.append(importer.convert_slide(slide_obj, index, skipped))
            except Exception as exc:
                # One unreadable slide must not cost the other ninety-five.
                report.warnings.append(f"Slide {index + 1} failed: {exc}")
                report.unsupported["<slide>"] += 1
                slides.append(
                    {
                        "id": f"slide-{index + 1}",
                        "name": f"Slide {index + 1} (failed to import)",
                        "background": {"color": "#ffffff", "image": None},
                        "notes": "",
                        "elements": [],
                        "timeline": [],
                    }
                )

        _classify_text_roles(slides)

        report.slides = len(slides)
        report.elements = sum(len(s["elements"]) for s in slides)

        deck = {
            "version": 1,
            "title": path.stem,
            "canvas": {"w": canvas_w, "h": canvas_h},
            "theme": "theme.css",
            "slides": slides,
        }

        if write:
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "assets").mkdir(exist_ok=True)
            (out_dir / "deck.json").write_text(
                json.dumps(deck, indent=2) + "\n", encoding="utf8"
            )
            theme_path = out_dir / "theme.css"
            if not theme_path.exists():
                theme_path.write_text(THEME_CSS, encoding="utf8")

        return deck, report
    finally:
        pkg.close()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Import a Keynote .key file.")
    parser.add_argument("input", type=Path, help="Path to a .key file or bundle")
    parser.add_argument("--out", type=Path, help="Deck folder to create")
    parser.add_argument(
        "--report",
        action="store_true",
        help="Analyse only: print a coverage report without writing anything",
    )
    args = parser.parse_args(argv)

    if not args.input.exists():
        sys.stderr.write(f"No such file: {args.input}\n")
        return 2
    if not args.report and args.out is None:
        sys.stderr.write("--out is required unless --report is given\n")
        return 2

    out_dir = args.out or Path(os.devnull)
    try:
        # stdout is a machine-readable channel: the Electron main process parses
        # it as JSON. Libraries in the dependency tree (PyMuPDF in particular)
        # print warnings straight to stdout, which would corrupt it, so
        # everything the import emits is diverted to stderr.
        with redirect_stdout(sys.stderr):
            deck, report = import_key(args.input, out_dir, write=not args.report)
    except SystemExit as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    except Exception:
        traceback.print_exc()
        return 1

    # stdout is the machine-readable channel the Electron main process reads.
    json.dump(
        {"dir": str(out_dir), "report": report.to_dict(), "deck": deck if not args.report else None},
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
