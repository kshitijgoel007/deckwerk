# Handoff — Slide Editor

State as of the end of session 2. Everything below is verified unless marked
otherwise. Read [README.md](README.md) first for what the tool is and how the
deck format works; this document is about **where we are and what is next**.

## How to run it

```bash
npm install
npm run setup:importer          # Python venv for the Keynote importer
npm run dev -- examples/test-presentation
```

`npm run dev` hot-reloads renderer changes. Two gotchas that have already
bitten us:

- **`npm run dev` does not rebuild the export bundle.** Run `npm run build:export`
  before using *Export web…*, or you will test a stale player. This is what made
  a fixed image crop look broken.
- The **importer venv** (`.venv-import/`) is separate from npm. If import fails
  with "keynote-parser is not installed", re-run `npm run setup:importer`.

### The browser harness — use this for UI bugs

```bash
npx vite --config vite.harness.config.ts --port 5601
# http://localhost:5601/dev/harness/editor.html
# http://localhost:5601/dev/harness/trim.html
```

Runs the **real** editor canvas and trim window in a plain browser with a
stubbed preload bridge (`dev/harness/`). This exists because **jsdom missed two
real bugs** that the harness found in minutes. Reach for it before trusting a
passing unit test on anything interaction-shaped.

## Verified working

- Editor: drag, 8-handle resize, snapping guides, multi-select, undo/redo,
  z-order, slide rail, autosave.
- **Double-click text to edit in place**; double-click video to play in place.
- Trim & Crop window: always-visible crop rectangle with 8 handles, live
  `W × H` badge, in/out frame thumbnails that update while dragging, the exact
  ffmpeg command shown before running.
- Player/timeline: appear-on-click builds, autoplay+loop video, present
  fullscreen, standalone web export.
- Keynote import across **24 real lecture decks** (~1,550 slides, ~16,000
  elements): every deck imports, ~0.2% of objects become visible placeholders
  (only tables and charts).
- 53 tests pass: `npm test`, or with import fixtures:
  `KEYNOTE_FIXTURES=/path/to/decks npm test`.

## The reference deck — what it proved

`reference.key` (9 slides, known geometry) is the most valuable artefact we
have. Confirmed **correct**: top-left position origin, centring (slide 3 lands
at 556.9, 237.7 — exact), and cropping in all three forms (slides 2, 5, 6).
Confirmed **and fixed**: rotation was reported as `-330°` instead of `30°`.

Sizes are `width × height` with width first — slide 1 and 7 are 400×300, not
300×400. There is no axis swap.

**Next step: turn `reference.key` into a permanent regression test.** The
expectations are known and stable; nothing guards them yet. This is the single
highest-value hour of work available.

## Open bugs, most important first

### 1. Red box on slides 14–16 is slightly too tall

**Mostly diagnosed and largely fixed.** Vincent's screenshots resolved most of
this; what follows is the remainder.

Two things turned out **not** to be bugs:

- **Slide 11 is correct.** Image at (48, 433.7), boxes at y=430 — they align,
  matching the Keynote screenshot. An earlier report of a 165px mismatch came
  from reading a stale `deck.json`. Re-import before trusting a dump.
- **The two stacked image crops on slides 14–16 are deliberate.** The tall crop
  (844×636) is the full figure; the white box on top of it masks everything
  below the noise strip. That is how the build reveals rows. The composition is
  right.

The real bug was the **black border** on that white masking box — now fixed (see
the stroke rule below).

**What remains:** the red outline box is still slightly taller than the noise
strip it should wrap tightly (imported 848×213.8; the strip is ~820×180 in the
Keynote screenshot). Two candidates, both unverified:

1. Path shapes render with `viewBox = pathSize` and `preserveAspectRatio: none`,
   so element box and path natural size stretch independently. Where they
   differ, **stroke width scales anisotropically** — a 7px stroke is not 7px.
   See `renderShape` in [src/renderer/player/render.ts](src/renderer/player/render.ts).
2. Keynote centres strokes on the path, so visible bounds extend
   `strokeWidth / 2` beyond the geometry. We do not account for this — with a
   7px stroke that is 3.5px on each side, which is the right order of magnitude
   but probably not the whole ~30px discrepancy.

Compare against `test_presentation.key` slide 14 and the screenshot in the
session-2 transcript.

### 2. Text wrapping estimates are approximate

We have no font metrics, so an auto-sizing box is estimated from character
count at the real font size (`_size_text_box`). Slide 11's
`"Text only, "Wrong Language""` gets 446px from Keynote for text needing ~950px
at 64px, so it wraps to 3 lines and overflows its bar. Position is right; the
box needs widening by hand.

A real fix would measure text with a canvas `measureText` pass, which means
doing the sizing in the renderer rather than the importer. Worth considering,
not urgent.

## DECIDED: CSS crop/trim is the standard. ffmpeg is parked.

Agreed with Vincent at the end of session 2. **Stop developing the ffmpeg
direction** — do not delete it, just leave it where it is. Shipping the full
video in an export is acceptable, so the file-shrinking argument for baking no
longer applies.

### Interface, as specified

- **Crop (images, video, GIFs alike): an "Edit mask" button** on the selected
  element, which turns on the same 8 handles used for resizing, operated
  directly on the slide. If in-place proves awkward, a separate window like the
  old trim one is an acceptable fallback — but try in-place first.
- **Trim: in the sidebar**, not under the video. Two handles over a timeline
  representing in/out points.
- **Looping must respect the trim.** A trimmed, looping clip has to loop
  `start → end`, not run to the end of the file. This is the piece most likely
  to be got wrong: it needs handling in the player's timeline runtime
  ([src/renderer/player/player.ts](src/renderer/player/player.ts)), not just in
  the `<video>` element's `loop` attribute, since `loop` always restarts at 0.

### What already exists to build on

- Image crop is **already CSS**: `sourceBox` on an image element positions the
  full picture inside an overflow-hidden window
  ([deck.ts](src/shared/deck.ts), [render.ts](src/renderer/player/render.ts)).
  Add the identical field to the video element.
- The video element **already has `start` / `end`** in the schema; the player
  ignores them today.
- Handle geometry and snapping already exist in
  [canvas.ts](src/renderer/editor/canvas.ts) and
  [snapping.ts](src/renderer/editor/snapping.ts) — reuse, do not rewrite.

### Superseded plan (kept for context)

Vincent's instinct here is right and we should act on it.

**We already crop images in CSS** — `sourceBox` on an image element positions
the full picture inside an overflow-hidden window
([deck.ts](src/shared/deck.ts), [render.ts](src/renderer/player/render.ts)).
Video could use exactly the same mechanism, and the schema *already* carries
non-destructive `start` / `end` fields on video elements.

Proposed direction:

- **Default to non-destructive, in-place, CSS-based crop and trim** for video,
  images and GIFs. Instant, reversible, editable later, no re-encode, and it
  works in the editor canvas rather than a separate window.
- Add `sourceBox` to the video element (same shape as the image one) and honour
  `start`/`end` in the player's timeline runtime.
- Build **one** in-place crop interaction on the editor canvas that works for
  image, video and GIF alike — a crop mode on the selected element reusing the
  handle code already in [canvas.ts](src/renderer/editor/canvas.ts) and
  [snapping.ts](src/renderer/editor/snapping.ts).
- **Keep ffmpeg, demote it to "Bake".** It remains the only way to actually
  shrink a file, and that matters: an exported deck currently ships the *whole*
  source video even if you show two seconds of it. Offer it as an explicit
  action, and consider baking automatically on export.

The trim window then becomes optional rather than the primary path. Nothing
already built is wasted — `buildTrimArgs`/`runTrim` in
[ffmpeg.ts](src/main/ffmpeg.ts) are tested against real binaries and keep
working as the bake step.

## Smaller open items

- **Image crop in-place** — covered by the design change above.
- **Slide backgrounds** import as white; Keynote's slide fill is never read.
  Likely a `SlideArchive.style` → fill walk, same pattern as
  `resolve_shape_style`.
- **Tables and charts** import as placeholders (`TableInfoArchive`,
  `ChartDrawableArchive`) — about 0.2% of objects across 24 decks.
- **Keynote builds** are not imported at all; slides land fully visible.
- **Rotated groups** are flattened without composing child rotation.
- **Multi-select resize** moves elements but does not scale them as a group.
- **PyInstaller Linux build** is unverified. The macOS binary is verified to run
  with an empty environment (`env -i`). PyMuPDF is now a dependency and needs
  checking under `--collect-all`.

## Fixed this session (do not re-investigate)

| Symptom | Root cause |
|---|---|
| Double-click to edit did nothing | Full re-render on every pointerup detached the pressed node, so the browser never synthesised `click`/`dblclick`. Fixed with overlay-only redraw, a 3px drag threshold, and rebuilding the slide DOM only when content actually changed |
| No crop handles | The rectangle was hidden behind a "Crop" checkbox — a design error. It is now always visible at full frame; a full-frame crop is simply not sent to ffmpeg |
| Video overflowed the trim window | `max-height: 100%` had no definite height to resolve against; viewer is now a positioned frame |
| Frame previews black | Waited on `loadedmetadata`, but at t=0 no seek occurs so no `seeked` fires and no frame is decoded. Now waits for `loadeddata`, with timeouts so a stuck seek cannot wedge the queue |
| Slide 1 image broken | It is a **PDF** (`mit-770.pdf`); browsers will not render one in `<img>`. Now rasterised with PyMuPDF |
| GIF not playing (slide 6) | Keynote stores GIFs as *movies*, so we emitted `<video src="….gif">`, which cannot decode. Now emitted as an image |
| Import randomly failed after adding PyMuPDF | PyMuPDF prints warnings to **stdout**, corrupting the JSON channel. All import output now goes to stderr |
| Vertical text (slides 17, 18) | Auto-sizing boxes store width/height `0.0`; we clamped to 1px |
| Wrong font sizes | We guessed from box height instead of reading `char_properties.font_size` |
| Invisible labels on dark boxes | Font colour was dropped, so white text rendered black |
| Slide 11 image huge/mispositioned | Used the image's geometry instead of its `MaskArchive` |
| Rotation shown as -330° | Not normalised into (-180, 180] |
| Empty text boxes | Now import with placeholder text (`.kn-text.placeholder`), matching Keynote |
| Black border around solid boxes (slides 11, 12, 14–16) | Keynote themes define a default 1px black stroke that the app does not paint on filled shapes. `resolve_shape_style` now records the inheritance depth of a stroke, and `_convert_vector` drops it when it came from an ancestor **and** the shape has a fill. Unfilled shapes — lines, arrows, connectors, outline boxes — still inherit theirs |

## Working rule: fix the importer, never the output

Every geometry and styling problem so far has been fixed in
[importers/keynote/import_keynote.py](importers/keynote/import_keynote.py), and
no `deck.json` has ever been hand-edited. The loop to keep using:

```bash
rm -rf examples/test-presentation
./.venv-import/bin/python importers/keynote/import_keynote.py test_presentation.key --out examples/test-presentation
npx vitest run test/importGeometry.test.ts
```

Then export and look at it. **Always delete and re-import** — reading a stale
`deck.json` cost us a wrong diagnosis of slide 11.

## Things worth knowing

- **Forking `keynote-parser` would not have helped.** It is a decoder, not an
  interpreter — it returns raw protobuf and stops. Every import bug so far has
  been in our ~1,000-line semantic layer
  ([importers/keynote/import_keynote.py](importers/keynote/import_keynote.py)),
  with the correct value already present in the decoded message. The one case
  that *would* justify a fork is a future Keynote version whose type mappings
  are missing; the package ships a `dumper/` module for regenerating them.
- **Import must never fail.** Unknown archives become visible `unsupported`
  placeholders that keep their geometry. Keep that invariant.
- The store deep-clones the deck on every mutation, so **object identity is an
  exact test for "did content change"** — the canvas relies on this to avoid
  needless rebuilds.
- Videos must be `muted` to autoplay in Chromium. This is not cosmetic.

## Questions outstanding for Vincent

1. Screenshots of Keynote slides **11 and 14** from `test_presentation.key`, to
   fix the box sizing without guessing.
2. Confirm slide 8 of `reference.key` really is an **empty** text box (its data
   contains only `U+FFFC`, an object-replacement placeholder).
3. Agreement on the CSS-crop direction above before it gets built.
