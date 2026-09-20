import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const workspaceDir = "/Users/vincentsitzmann/Coding/deckwerk";
const SKILL_DIR = "/Users/vincentsitzmann/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.12148/skills/presentations";
const buildDir = path.join(workspaceDir, ".codex/pptx-fixture-build");
const outputDir = path.join(workspaceDir, "artifacts/pptx-fixtures");
const runtimePython = "/Users/vincentsitzmann/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const fontFamily = "Arial";
const expectedSlideSizeEmu = "12192000,6858000";
const videoPath = path.join(buildDir, "video-calibration.mp4");

const { finalizePresentation, applyPresentationChartFont } = await import(
  pathToFileURL(path.join(SKILL_DIR, "container_tools/artifact_tool_utils.mjs")).href,
);

await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(outputDir, { recursive: true });
execFileSync("/opt/homebrew/bin/ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=800x500:rate=30:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoPath], { stdio: "ignore" });

const palette = {
  navy: "#10243E",
  blue: "#246BCE",
  cyan: "#27B9D6",
  green: "#1E9E68",
  amber: "#E6A117",
  orange: "#E76F3C",
  red: "#D64545",
  purple: "#7656C9",
  ink: "#142033",
  muted: "#5B687A",
  pale: "#F3F6FA",
  line: "#C7D0DD",
  white: "#FFFFFF",
};

function configureTheme(presentation, name) {
  presentation.theme.colorScheme = {
    name,
    themeColors: {
      accent1: palette.blue,
      accent2: palette.orange,
      accent3: palette.green,
      accent4: palette.purple,
      accent5: palette.cyan,
      accent6: palette.amber,
      bg1: palette.white,
      bg2: palette.pale,
      tx1: palette.ink,
      tx2: palette.muted,
      dk1: "#000000",
      dk2: palette.navy,
      lt1: palette.white,
      lt2: "#E7ECF2",
      hlink: "#0563C1",
      folHlink: "#954F72",
    },
  };
}

function addLayouts(presentation) {
  const standard = presentation.layouts.add("Calibration Standard");
  const title = standard.placeholders.add({
    type: "title", index: 0, geometry: "textbox",
    position: { left: 60, top: 28, width: 1160, height: 56 }, text: "Title",
  });
  title.text.style = {
    typeface: fontFamily, fontSize: 30, bold: true, color: "tx1",
    autoFit: "none", insets: { left: 0, right: 0, top: 0, bottom: 0 },
  };
  const body = standard.placeholders.add({
    type: "body", index: 0, geometry: "textbox",
    position: { left: 60, top: 104, width: 1160, height: 552 }, text: "Body",
  });
  body.text.style = {
    typeface: fontFamily, fontSize: 20, color: "tx1", autoFit: "none",
    insets: { left: 0, right: 0, top: 0, bottom: 0 },
  };

  const alternate = presentation.layouts.add("Calibration Alternate");
  const altTitle = alternate.placeholders.add({
    type: "title", index: 0, geometry: "textbox",
    position: { left: 82, top: 42, width: 720, height: 72 }, text: "Title",
  });
  altTitle.text.style = {
    typeface: fontFamily, fontSize: 34, bold: true, color: "#FFFFFF",
    autoFit: "none", insets: { left: 0, right: 0, top: 0, bottom: 0 },
  };
  const altBody = alternate.placeholders.add({
    type: "body", index: 0, geometry: "roundRect",
    position: { left: 82, top: 146, width: 1116, height: 500 },
    fill: "#FFFFFF", line: { style: "solid", fill: "#C7D0DD", width: 2 },
    text: "Body",
  });
  altBody.text.style = {
    typeface: fontFamily, fontSize: 20, color: "tx1", autoFit: "none",
    insets: { left: 20, right: 20, top: 16, bottom: 16 },
  };
}

function addLabel(slide, id) {
  const label = slide.shapes.add({
    geometry: "textbox", name: `${id}-label`,
    position: { left: 1088, top: 674, width: 132, height: 22 },
    fill: "none", line: { fill: "none", width: 0 },
  });
  label.text = id;
  label.text.style = {
    typeface: fontFamily, fontSize: 11, color: "#657386", alignment: "right",
    autoFit: "none", insets: { left: 0, right: 0, top: 0, bottom: 0 },
  };
}

function setNotes(slide, id, purpose, objects, expected = "native") {
  slide.speakerNotes.textFrame.setText([
    `REF-ID: ${id}`,
    `EXPECTED: ${expected}`,
    `PURPOSE: ${purpose}`,
    `OBJECTS: ${objects.join("; ")}`,
    "AUTHORING: Generated with @oai/artifact-tool. Slide size 1280x720 CSS px = 13.333x7.5 in.",
  ]);
  slide.speakerNotes.setVisible(true);
}

function coreSlide(presentation, id, title, layout = "Calibration Standard") {
  const slide = presentation.slides.add({ layout });
  slide.background.fill = layout === "Calibration Alternate" ? palette.navy : palette.white;
  slide.placeholders.getItem("title").text = title;
  const body = slide.placeholders.getItem("body");
  body.text = "";
  addLabel(slide, id);
  return slide;
}

function addTextBox(slide, name, text, position, style = {}, box = {}) {
  const shape = slide.shapes.add({
    geometry: box.geometry ?? "textbox", name, position,
    fill: box.fill ?? "none",
    line: box.line ?? { fill: "none", width: 0 },
    ...(box.rotation !== undefined ? { rotation: box.rotation } : {}),
  });
  shape.text = text;
  shape.text.style = {
    typeface: fontFamily, fontSize: 20, color: palette.ink,
    autoFit: "none", insets: { left: 8, right: 8, top: 6, bottom: 6 },
    ...style,
  };
  return shape;
}

function addCaption(slide, text, left, top, width = 180) {
  return addTextBox(slide, `caption-${text}`, text, { left, top, width, height: 28 }, {
    fontSize: 13, color: palette.muted, alignment: "center",
    insets: { left: 0, right: 0, top: 0, bottom: 0 },
  });
}

function calibrationSvg() {
  const markup = `
  <svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
    <rect width="800" height="500" fill="#ffffff"/>
    <rect x="0" y="0" width="400" height="250" fill="#e53935"/>
    <rect x="400" y="0" width="400" height="250" fill="#1e88e5"/>
    <rect x="0" y="250" width="400" height="250" fill="#43a047"/>
    <rect x="400" y="250" width="400" height="250" fill="#fdd835"/>
    <path d="M0 250H800M400 0V500" stroke="#111827" stroke-width="8"/>
    <rect x="20" y="20" width="760" height="460" fill="none" stroke="#111827" stroke-width="12"/>
    <g font-family="Arial" font-size="72" font-weight="700" fill="#ffffff" text-anchor="middle">
      <text x="200" y="145">TL</text><text x="600" y="145">TR</text>
      <text x="200" y="400">BL</text><text x="600" y="400" fill="#111827">BR</text>
    </g>
    <circle cx="400" cy="250" r="42" fill="#ffffff" stroke="#111827" stroke-width="8"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(markup).toString("base64")}`;
}

async function buildCore() {
  const p = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  configureTheme(p, "PPTX Import Fidelity");
  addLayouts(p);

  {
    const s = coreSlide(p, "CORE-01", "Layout and placeholder inheritance");
    const body = s.placeholders.getItem("body");
    body.text = "This body text inherits its geometry and base style from the layout.";
    body.text.style = { typeface: fontFamily, fontSize: 26, color: "tx1", autoFit: "none", verticalAlignment: "middle", alignment: "center" };
    s.shapes.add({ geometry: "rect", name: "theme-accent1", position: { left: 120, top: 214, width: 220, height: 100 }, fill: "accent1", line: { fill: "none", width: 0 } });
    s.shapes.add({ geometry: "rect", name: "theme-accent2", position: { left: 530, top: 214, width: 220, height: 100 }, fill: "accent2", line: { fill: "none", width: 0 } });
    s.shapes.add({ geometry: "rect", name: "theme-accent3", position: { left: 940, top: 214, width: 220, height: 100 }, fill: "accent3", line: { fill: "none", width: 0 } });
    setNotes(s, "CORE-01", "Theme and layout placeholder inheritance", ["title placeholder", "body placeholder", "accent1/2/3 theme fills"]);
  }

  {
    const s = coreSlide(p, "CORE-02", "Canvas geometry and edge behavior");
    const specs = [
      ["exact-a", 96, 96, 216, 134, palette.red],
      ["exact-b", 437, 154, 183, 271, palette.blue],
      ["exact-c", 770, 113, 327, 177, palette.green],
      ["bottom-edge", 78, 570, 292, 86, palette.purple],
      ["right-edge", 1124, 380, 96, 208, palette.amber],
    ];
    for (const [name, left, top, width, height, fill] of specs) {
      s.shapes.add({ geometry: "rect", name, position: { left, top, width, height }, fill, line: { style: "solid", fill: "#111827", width: 2 } });
      addCaption(s, `${name} ${left},${top} ${width}x${height}`, left, top + height + 4, Math.max(150, width));
    }
    setNotes(s, "CORE-02", "Exact geometry, canvas edges, and non-symmetric dimensions", specs.map(x => `${x[0]} x=${x[1]} y=${x[2]} w=${x[3]} h=${x[4]}`));
  }

  {
    const s = coreSlide(p, "CORE-03", "Rotation, flips, transparency, and stacking");
    const back = s.shapes.add({ geometry: "rect", name: "stack-back", position: { left: 130, top: 180, width: 390, height: 270 }, fill: "#246BCE/70", line: { style: "solid", fill: palette.navy, width: 3 } });
    const mid = s.shapes.add({ geometry: "ellipse", name: "stack-mid-rot17", position: { left: 310, top: 250, width: 330, height: 190, rotation: 17 }, fill: "#E76F3C/68", line: { style: "solid", fill: palette.red, width: 4 } });
    const front = s.shapes.add({ geometry: "triangle", name: "stack-front-rot-31", position: { left: 500, top: 160, width: 250, height: 310, rotation: -31, horizontalFlip: true }, fill: "#1E9E68/72", line: { style: "solid", fill: "#0B6240", width: 3 } });
    back.sendToBack(); mid.bringToFront(); front.bringToFront();
    s.shapes.add({ geometry: "rightArrow", name: "flip-horizontal", position: { left: 830, top: 170, width: 280, height: 110, horizontalFlip: true }, fill: palette.purple, line: { fill: "none", width: 0 } });
    s.shapes.add({ geometry: "triangle", name: "flip-vertical", position: { left: 865, top: 380, width: 190, height: 180, verticalFlip: true }, fill: palette.amber, line: { fill: "none", width: 0 } });
    setNotes(s, "CORE-03", "Object order, rotations, opacity, and shape flips", ["stack-back", "stack-mid-rot17", "stack-front-rot-31", "flip-horizontal", "flip-vertical"]);
  }

  {
    const s = coreSlide(p, "CORE-04", "Run-level text formatting");
    const box = addTextBox(s, "rich-runs", "", { left: 88, top: 132, width: 1104, height: 230 }, { fontSize: 34, verticalAlignment: "middle" }, { fill: palette.pale, line: { style: "solid", fill: palette.line, width: 2 }, geometry: "roundRect" });
    box.text.set([
      [
        { run: "Regular ", textStyle: { fontSize: "26pt", typeface: fontFamily, color: palette.ink } },
        { run: "Bold ", textStyle: { fontSize: "26pt", typeface: fontFamily, color: palette.red, bold: true } },
        { run: "Italic ", textStyle: { fontSize: "26pt", typeface: fontFamily, color: palette.blue, italic: true } },
        { run: "Underline ", textStyle: { fontSize: "26pt", typeface: fontFamily, color: palette.green, underline: "sng" } },
      ],
      [
        { run: "18 pt ", textStyle: { fontSize: "18pt", typeface: fontFamily } },
        { run: "32 pt ", textStyle: { fontSize: "32pt", typeface: fontFamily, bold: true } },
        { run: "Theme accent", textStyle: { fontSize: "24pt", typeface: fontFamily, color: "accent4" } },
      ],
      [{ run: "Agj pqy 0123456789 AV WA fi fl αβγ", textStyle: { fontSize: "24pt", typeface: fontFamily, color: palette.navy } }],
    ]);
    const gradient = addTextBox(s, "gradient-text", "Gradient text fill", { left: 190, top: 430, width: 900, height: 90 }, { fontSize: 50, bold: true, alignment: "center" });
    gradient.text.fill = { type: "gradient", gradientKind: "linear", angleDeg: 0, stops: [{ offset: 0, color: palette.red }, { offset: 50000, color: palette.purple }, { offset: 100000, color: palette.blue }] };
    setNotes(s, "CORE-04", "Run-level text formatting and gradient text", ["rich-runs", "gradient-text"]);
  }

  {
    const s = coreSlide(p, "CORE-05", "Text-box alignment, margins, and wrapping");
    const positions = [
      ["top-left", 78, 150, "left", "top", { left: 6, right: 18, top: 4, bottom: 24 }],
      ["middle-center", 352, 150, "center", "middle", { left: 18, right: 6, top: 24, bottom: 4 }],
      ["bottom-right", 626, 150, "right", "bottom", { left: 22, right: 11, top: 10, bottom: 19 }],
      ["justify", 900, 150, "justify", "top", { left: 10, right: 10, top: 10, bottom: 10 }],
    ];
    for (const [name, left, top, alignment, verticalAlignment, insets] of positions) {
      addTextBox(s, name, "Line one wraps here\nLine two has gjpq", { left, top, width: 236, height: 190 }, { fontSize: 22, alignment, verticalAlignment, insets }, { fill: palette.pale, line: { style: "solid", fill: palette.blue, width: 2 } });
      addCaption(s, name, left, 346, 236);
    }
    addTextBox(s, "no-wrap", "No wrap: 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ", { left: 78, top: 410, width: 430, height: 64 }, { fontSize: 24, wrap: "none" }, { fill: "#FFF4E6", line: { style: "solid", fill: palette.orange, width: 2 } });
    addTextBox(s, "rotated-text", "Rotated text box 17°", { left: 720, top: 410, width: 360, height: 80, rotation: 17 }, { fontSize: 28, alignment: "center", verticalAlignment: "middle" }, { fill: "#EEF7F2", line: { style: "solid", fill: palette.green, width: 2 } });
    setNotes(s, "CORE-05", "Horizontal and vertical alignment, asymmetric insets, wrap none, rotated text", positions.map(x => x[0]).concat(["no-wrap", "rotated-text"]));
  }

  {
    const s = coreSlide(p, "CORE-06", "PowerPoint autofit modes");
    const copy = "This deliberately long sentence fills a constrained box and exposes differences in PowerPoint text fitting, wrapping, and final font size.";
    const modes = [
      ["no-autofit", "none", 80],
      ["shrink-text", "shrinkText", 456],
      ["resize-shape", "resizeShapeToFitText", 832],
    ];
    for (const [name, autoFit, left] of modes) {
      addTextBox(s, name, copy, { left, top: 166, width: 300, height: 160 }, { fontSize: 34, autoFit, verticalAlignment: "top" }, { fill: palette.pale, line: { style: "solid", fill: palette.red, width: 2 } });
      addCaption(s, `${name} · 34 px`, left, 342, 300);
    }
    setNotes(s, "CORE-06", "Do not autofit, shrink text, and resize shape to fit", modes.map(x => `${x[0]}=${x[1]}`));
  }

  {
    const s = coreSlide(p, "CORE-07", "Paragraph spacing and nested lists");
    const list = addTextBox(s, "nested-list", "", { left: 90, top: 130, width: 520, height: 430 }, { fontSize: 25, lineSpacing: 1.15 }, { fill: "#F8FAFC", line: { style: "solid", fill: palette.line, width: 2 } });
    list.text.set([
      { bulletCharacter: "•", marginLeft: 22 * 12700, indent: -12 * 12700, spaceAfter: 700, runs: [{ run: "Level 0", textStyle: { bold: true, color: palette.blue } }, " with spacing after"] },
      { bulletCharacter: "–", marginLeft: 44 * 12700, indent: -12 * 12700, spaceBefore: 300, runs: ["Level 1 custom dash"] },
      { bulletCharacter: "◆", marginLeft: 66 * 12700, indent: -12 * 12700, runs: ["Level 2 custom diamond"] },
      { bulletCharacter: "•", marginLeft: 22 * 12700, indent: -12 * 12700, runs: ["Back to level 0"] },
    ]);
    const paras = addTextBox(s, "paragraph-alignment", "", { left: 690, top: 130, width: 500, height: 430 }, { fontSize: 23 }, { fill: "#FFF9ED", line: { style: "solid", fill: palette.amber, width: 2 } });
    paras.text.set([
      { spaceAfter: 1200, runs: [{ run: "Left paragraph with 12 pt after", textStyle: { bold: true } }], paragraphStyle: { alignment: "left" } },
      { spaceBefore: 600, spaceAfter: 600, runs: ["Centered paragraph with explicit before and after spacing"], paragraphStyle: { alignment: "center" } },
      { runs: ["Right aligned final paragraph"], paragraphStyle: { alignment: "right" } },
    ]);
    setNotes(s, "CORE-07", "Bullet characters, list indentation, paragraph spacing and alignment", ["nested-list", "paragraph-alignment"]);
  }

  {
    const s = coreSlide(p, "CORE-08", "Solid, transparent, gradient, and pattern fills");
    const fills = [
      ["solid", palette.blue],
      ["transparent-50", "#D64545/50"],
      ["theme-tint", "accent3+25/85"],
      ["linear", { type: "gradient", gradientKind: "linear", angleDeg: 35, stops: [{ offset: 0, color: palette.red }, { offset: 50000, color: palette.amber }, { offset: 100000, color: palette.blue }] }],
      ["radial", { type: "gradient", gradientKind: "path", stops: [{ offset: 0, color: palette.white }, { offset: 100000, color: palette.purple }] }],
      ["pattern", { type: "solid", color: "#F8FAFC", pattern: { type: "diagonalCross", color: "#246BCE/70" } }],
    ];
    fills.forEach(([name, fill], index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const left = 94 + col * 392;
      const top = 140 + row * 240;
      s.shapes.add({ geometry: index === 4 ? "ellipse" : "roundRect", name, position: { left, top, width: 300, height: 150 }, fill, line: { style: "solid", fill: palette.navy, width: 2 } });
      addCaption(s, name, left, top + 164, 300);
    });
    setNotes(s, "CORE-08", "Fill parsing, color transforms, gradients, transparency, and patterns", fills.map(x => x[0]));
  }

  {
    const s = coreSlide(p, "CORE-09", "Line styles, arrowheads, and connectors");
    const styles = ["solid", "dashed", "dotted", "dash-dot", "dash-dot-dot"];
    styles.forEach((style, index) => {
      s.shapes.add({ geometry: "line", name: `line-${style}`, position: { left: 96, top: 130 + index * 66, width: 450, height: index % 2 ? 28 : 0 }, fill: "none", line: { style, fill: [palette.navy, palette.blue, palette.green, palette.orange, palette.purple][index], width: index + 1 } });
      addTextBox(s, `line-label-${style}`, `${style} · ${index + 1}px`, { left: 566, top: 114 + index * 66, width: 190, height: 36 }, { fontSize: 16, verticalAlignment: "middle" });
    });
    const a = s.shapes.add({ geometry: "ellipse", name: "connector-source", position: { left: 820, top: 150, width: 150, height: 90 }, fill: palette.pale, line: { style: "solid", fill: palette.blue, width: 3 } });
    const b = s.shapes.add({ geometry: "roundRect", name: "connector-target", position: { left: 1030, top: 420, width: 160, height: 100 }, fill: "#FFF4E6", line: { style: "solid", fill: palette.orange, width: 3 } });
    a.text = "FROM"; b.text = "TO";
    for (const node of [a, b]) node.text.style = { typeface: fontFamily, fontSize: 20, bold: true, alignment: "center", verticalAlignment: "middle" };
    s.shapes.connect(a, b, { kind: "curved", fromSide: "bottom", toSide: "top", line: { style: "dashed", fill: palette.purple, width: 4 }, head: { type: "triangle", width: "lg", length: "lg" }, tail: { type: "oval", width: "sm", length: "sm" } });
    setNotes(s, "CORE-09", "Line dash styles, weights, diagonal geometry, and connected arrowheads", styles.map(x => `line-${x}`).concat(["curved connector"]));
  }

  {
    const s = coreSlide(p, "CORE-10", "Preset shapes and adjustment geometry");
    const geometries = ["rect", "roundRect", "ellipse", "triangle", "diamond", "parallelogram", "trapezoid", "chevron", "rightArrow", "leftRightArrow", "star5", "donut", "pie", "heart", "flowChartTerminator", "flowChartDocument", "cube", "can"];
    geometries.forEach((geometry, index) => {
      const col = index % 6;
      const row = Math.floor(index / 6);
      const left = 72 + col * 198;
      const top = 116 + row * 176;
      const shape = s.shapes.add({ geometry, name: `preset-${geometry}`, position: { left, top, width: 138, height: 106 }, fill: [palette.blue, palette.orange, palette.green, palette.purple, palette.cyan, palette.amber][col] + "CC", line: { style: "solid", fill: palette.navy, width: 2 }, ...(geometry === "roundRect" ? { adjustmentList: [{ name: "adj", formula: "val 32000" }] } : {}) });
      if (geometry === "roundRect") shape.borderRadius = 30;
      addCaption(s, geometry, left - 10, top + 112, 158);
    });
    setNotes(s, "CORE-10", "PowerPoint preset geometry and non-default rounded-rectangle adjustment", geometries.map(x => `preset-${x}`));
  }

  {
    const s = coreSlide(p, "CORE-11", "Custom freeform paths");
    s.shapes.add({
      geometry: "custom", name: "custom-zigzag",
      position: { left: 100, top: 150, width: 420, height: 300 },
      fill: "#246BCE/70", line: { style: "solid", fill: palette.navy, width: 4 },
      customPaths: [{ width: 420, height: 300, commands: [
        { moveTo: { x: 20, y: 40 } }, { lineTo: { x: 220, y: 10 } },
        { lineTo: { x: 390, y: 110 } }, { lineTo: { x: 250, y: 290 } },
        { lineTo: { x: 40, y: 240 } }, { close: {} },
      ] }],
    });
    s.shapes.add({
      geometry: "custom", name: "custom-open-path",
      position: { left: 690, top: 150, width: 420, height: 300, rotation: 13 },
      fill: "none", line: { style: "dashed", fill: palette.red, width: 6 },
      customPaths: [{ width: 420, height: 300, commands: [
        { moveTo: { x: 20, y: 250 } }, { lineTo: { x: 120, y: 70 } },
        { lineTo: { x: 240, y: 230 } }, { lineTo: { x: 400, y: 35 } },
      ] }],
    });
    addCaption(s, "closed custom path", 100, 474, 420);
    addCaption(s, "open custom path · 13°", 690, 474, 420);
    setNotes(s, "CORE-11", "Custom DrawingML path conversion, open versus closed path, and rotation", ["custom-zigzag", "custom-open-path"]);
  }

  {
    const s = coreSlide(p, "CORE-12", "Picture crops and masks");
    const svg = calibrationSvg();
    const pictures = [
      ["plain", 72, 128, 270, 170, {}, "rect"],
      ["crop-left-right", 373, 128, 210, 170, { left: 0.25, top: 0, right: 0.12, bottom: 0 }, "rect"],
      ["crop-asymmetric", 614, 128, 240, 170, { left: 0.08, top: 0.18, right: 0.23, bottom: 0.07 }, "roundRect"],
      ["circle", 885, 128, 180, 180, { left: 0.16, top: 0, right: 0.16, bottom: 0 }, "ellipse"],
    ];
    for (const [name, left, top, width, height, crop, geometry] of pictures) {
      const image = s.images.add({ dataUrl: svg, alt: `${name} TL TR BL BR crop calibration`, fit: "cover", position: { left, top, width, height }, ...(Object.keys(crop).length ? { crop } : {}), geometry, ...(geometry === "roundRect" ? { borderRadius: 28 } : {}) });
      if (name === "crop-asymmetric") image.rotation = -11;
      addCaption(s, name, left, top + height + 18, width);
    }
    const flipped = s.images.add({ dataUrl: svg, alt: "horizontal and vertical flip calibration", fit: "contain", position: { left: 290, top: 410, width: 620, height: 190 } });
    flipped.flipHorizontal = true;
    flipped.flipVertical = true;
    addCaption(s, "both flips · contain", 290, 612, 620);
    setNotes(s, "CORE-12", "SVG preference, crops, masks, rotation, fit, alt text, and picture flips", pictures.map(x => x[0]).concat(["both flips"]));
  }

  {
    const s = coreSlide(p, "CORE-13", "Native table geometry and cell formatting");
    const table = s.tables.add({
      rows: 4, columns: 4, left: 90, top: 150, width: 1100, height: 420,
      columnWidths: [190, 270, 300, 340],
      values: [
        ["Merged header", "", "", "Status"],
        ["A1", "B1", "C1", "D1"],
        ["A2", "B2 with longer wrapping text", "C2", "D2"],
        ["Merged 2×2", "", "C3", "D3"],
      ],
    });
    table.merge({ startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 });
    table.merge({ startRow: 2, endRow: 3, startColumn: 0, endColumn: 1 });
    table.rows[0].height = 64;
    table.rows[1].height = 80;
    table.rows[2].height = 126;
    table.rows[3].height = 150;
    table.borders.assign({ style: "solid", fill: palette.navy, width: 2 });
    table.cells.block({ row: 0, column: 0, rowCount: 1, columnCount: 4 }).assign({ fill: palette.navy, textStyle: { typeface: fontFamily, fontSize: 22, bold: true, color: palette.white }, anchor: "middle" });
    table.cells.block({ row: 1, column: 0, rowCount: 3, columnCount: 4 }).assign({ textStyle: { typeface: fontFamily, fontSize: 18, color: palette.ink }, margins: { left: 10, right: 18, top: 8, bottom: 14 }, anchor: "middle" });
    table.getCell(1, 1).fill = "#EAF2FC";
    table.getCell(2, 2).fill = { type: "gradient", gradientKind: "linear", angleDeg: 90, stops: [{ offset: 0, color: "#FFF4E6" }, { offset: 100000, color: "#F7D4C3" }] };
    table.getCell(2, 3).fill = "#DFF3E9";
    setNotes(s, "CORE-13", "Native table with unequal tracks, explicit row heights, merges, margins, fills, and borders", ["4x4 table", "header colspan=3", "2x2 merge"]);
  }

  {
    const s = coreSlide(p, "CORE-14", "Integrated composition with inherited layout", "Calibration Alternate");
    const body = s.placeholders.getItem("body");
    body.text = "";
    const svg = calibrationSvg();
    s.images.add({ dataUrl: svg, alt: "Integrated crop calibration", fit: "cover", position: { left: 110, top: 186, width: 440, height: 300 }, crop: { left: 0.12, top: 0.04, right: 0.2, bottom: 0.1 }, geometry: "roundRect", borderRadius: 24 });
    const headline = addTextBox(s, "integrated-headline", "Inherited layout, native objects", { left: 622, top: 188, width: 500, height: 76 }, { fontSize: 34, bold: true, color: palette.navy, insets: { left: 0, right: 0, top: 0, bottom: 0 } });
    const list = addTextBox(s, "integrated-list", "", { left: 622, top: 292, width: 500, height: 190 }, { fontSize: 22, color: palette.ink });
    list.text.set([
      { bulletCharacter: "•", marginLeft: 22 * 12700, indent: -12 * 12700, runs: ["Asymmetric picture crop"] },
      { bulletCharacter: "•", marginLeft: 22 * 12700, indent: -12 * 12700, runs: ["Theme-colored native geometry"] },
      { bulletCharacter: "•", marginLeft: 22 * 12700, indent: -12 * 12700, runs: ["Mixed inherited and direct text"] },
    ]);
    const start = s.shapes.add({ geometry: "ellipse", name: "integrated-start", position: { left: 656, top: 520, width: 110, height: 64 }, fill: "accent1", line: { fill: "none", width: 0 } });
    const end = s.shapes.add({ geometry: "roundRect", name: "integrated-end", position: { left: 964, top: 510, width: 150, height: 80 }, fill: "accent3", line: { fill: "none", width: 0 } });
    start.text = "A"; end.text = "B";
    for (const n of [start, end]) n.text.style = { typeface: fontFamily, fontSize: 24, bold: true, color: palette.white, alignment: "center", verticalAlignment: "middle" };
    s.shapes.connect(start, end, { kind: "elbow", fromSide: "right", toSide: "left", line: { style: "solid", fill: palette.cyan, width: 4 }, head: { type: "triangle", width: "med", length: "med" } });
    setNotes(s, "CORE-14", "Feature interaction on an alternate layout", ["alternate title/body placeholders", "cropped SVG", "rich list", "elbow connector"]);
  }

  {
    const s = coreSlide(p, "CORE-15", "Video crops, opacity, flips, and trimming");
    const svg = calibrationSvg();
    const cases = [
      ["crop", 70, 155, 250, 190, { left: 0.22, top: 0.08, right: 0.12, bottom: 0.18 }, "rect", "trim 1.25s / 0.75s"],
      ["circle", 370, 155, 190, 190, { left: 0.16, top: 0, right: 0.16, bottom: 0 }, "ellipse", "trim 0.5s / 0.5s"],
      ["opacity", 620, 155, 250, 190, { left: 0, top: 0, right: 0, bottom: 0 }, "rect", "45% opacity · trim 0.25s"],
      ["flips", 920, 155, 250, 190, { left: 0.08, top: 0.08, right: 0.08, bottom: 0.08 }, "rect", "H+V flip · trim 1s"],
    ];
    for (const [name, left, top, width, height, crop, geometry, detail] of cases) {
      s.images.add({ dataUrl: svg, alt: `VIDEOCASE ${name} embedded MP4 poster`, fit: "cover", position: { left, top, width, height }, crop, geometry });
      addCaption(s, name, left, top + height + 14, width);
      addCaption(s, detail, left, top + height + 40, width);
    }
    addTextBox(s, "video-source-note", "One embedded 6-second H.264 calibration clip; four independent native video shapes.", { left: 180, top: 510, width: 920, height: 54 }, { fontSize: 19, color: palette.muted, alignment: "center" });
    setNotes(s, "CORE-15", "Embedded video crop, ellipse mask, opacity, flips, and p14 trim metadata", ["crop video st=1250 end=750", "circle video st=500 end=500", "opacity video alpha=45000 st=250 end=250", "flipped video flipH+flipV st=1000 end=1000"]);
  }

  return p;
}

async function buildBoundary() {
  const p = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  configureTheme(p, "PPTX Import Boundaries");
  addLayouts(p);

  {
    const s = coreSlide(p, "EDGE-01", "Native column chart — expected fallback");
    const chart = s.charts.add("bar", {
      position: { left: 120, top: 165, width: 1040, height: 425 },
      categories: ["Alpha", "Beta", "Gamma", "Delta"],
      series: [
        { name: "2025", values: [24, 41, 33, 52], fill: palette.blue },
        { name: "2026", values: [31, 46, 44, 61], fill: palette.orange },
      ],
      barOptions: { direction: "column", grouping: "clustered", gapWidth: 52 },
      title: "Editable native PowerPoint chart",
      hasLegend: true,
      legend: { position: "bottom", overlay: false, textStyle: { typeface: fontFamily, fontSize: 14, fill: palette.muted } },
      xAxis: { visible: true, textStyle: { typeface: fontFamily, fontSize: 14, fill: palette.ink }, line: { style: "solid", fill: palette.line, width: 1 } },
      yAxis: { visible: true, min: 0, max: 70, majorUnit: 10, textStyle: { typeface: fontFamily, fontSize: 13, fill: palette.muted }, majorGridlines: { style: "solid", fill: "#DDE4EC", width: 1 } },
      dataLabels: { showValue: true, position: "outEnd", textStyle: { typeface: fontFamily, fontSize: 13, fill: palette.ink, bold: true } },
      chartFill: "#FFFFFF", chartLine: { style: "solid", fill: palette.line, width: 1 }, plotAreaFill: "#F8FAFC",
    });
    applyPresentationChartFont(chart, { fontFamily });
    setNotes(s, "EDGE-01", "Chart graphicFrame fallback behavior", ["editable clustered column chart", "legend", "data labels"], "unsupported placeholder or future native chart");
  }

  {
    const s = coreSlide(p, "EDGE-02", "Line + doughnut charts — expected fallback");
    const line = s.charts.add("line", {
      position: { left: 60, top: 165, width: 710, height: 395 },
      categories: ["Q1", "Q2", "Q3", "Q4"],
      series: [{ name: "Signal", values: [0.22, 0.38, 0.34, 0.57], line: { style: "solid", fill: palette.green, width: 4 }, marker: { symbol: "circle", size: 8 } }],
      hasLegend: false,
      xAxis: { textStyle: { typeface: fontFamily, fontSize: 13, fill: palette.muted } },
      yAxis: { min: 0, max: 0.7, majorUnit: 0.1, numberFormatCode: "0%", textStyle: { typeface: fontFamily, fontSize: 13, fill: palette.muted }, majorGridlines: { style: "solid", fill: palette.line, width: 1 } },
      dataLabels: { showValue: true, position: "outEnd", textStyle: { typeface: fontFamily, fontSize: 13, fill: palette.ink } },
    });
    applyPresentationChartFont(line, { fontFamily });
    const donut = s.charts.add("doughnut", {
      position: { left: 830, top: 180, width: 350, height: 330 },
      categories: ["Native", "Fallback", "Missing"],
      series: [{ name: "Share", values: [72, 23, 5], points: [{ idx: 0, fill: palette.blue }, { idx: 1, fill: palette.orange }, { idx: 2, fill: palette.red }] }],
      doughnutOptions: { holeSize: 58, firstSliceAngle: 25 },
      legend: { position: "bottom", overlay: false, textStyle: { typeface: fontFamily, fontSize: 12, fill: palette.muted } },
      dataLabels: { showPercent: true, position: "outEnd", textStyle: { typeface: fontFamily, fontSize: 12, fill: palette.ink } },
    });
    applyPresentationChartFont(donut, { fontFamily });
    setNotes(s, "EDGE-02", "Multiple chart families and paint order", ["line chart", "doughnut chart"], "unsupported placeholders or future native charts");
  }

  {
    const s = coreSlide(p, "EDGE-03", "Effects, outlines, and advanced paint");
    const shadows = ["shadow-sm", "shadow-md", "shadow-xl"];
    shadows.forEach((shadow, index) => {
      const sh = s.shapes.add({ geometry: index === 1 ? "ellipse" : "roundRect", name: `effect-${shadow}`, position: { left: 100 + index * 390, top: 170, width: 280, height: 180, rotation: index === 2 ? 12 : 0 }, fill: [palette.blue, palette.orange, palette.green][index], line: { style: "solid", fill: palette.navy, width: 3 }, shadow });
      sh.text = shadow;
      sh.text.style = { typeface: fontFamily, fontSize: 24, bold: true, color: palette.white, alignment: "center", verticalAlignment: "middle" };
    });
    const outlined = addTextBox(s, "outlined-text", "Outlined text", { left: 140, top: 440, width: 1000, height: 100 }, { fontSize: 60, bold: true, alignment: "center" });
    outlined.text.fill = { type: "gradient", gradientKind: "linear", angleDeg: 15, stops: [{ offset: 0, color: palette.red }, { offset: 100000, color: palette.purple }] };
    outlined.text.outline = { style: "solid", fill: palette.navy, width: 2 };
    setNotes(s, "EDGE-03", "Shadow effects and text fill/outline simplification", shadows.concat(["gradient outlined text"]), "approximation expected");
  }

  {
    const s = coreSlide(p, "EDGE-04", "Hyperlinks and action-like text runs");
    const linkBox = addTextBox(s, "hyperlink-runs", "", { left: 120, top: 150, width: 1040, height: 260 }, { fontSize: 34, verticalAlignment: "middle", alignment: "center" }, { fill: palette.pale, line: { style: "solid", fill: palette.line, width: 2 }, geometry: "roundRect" });
    linkBox.text.set([
      [{ run: "Plain text before ", textStyle: { fontSize: "28pt", typeface: fontFamily, color: palette.ink } }, { run: "external hyperlink", textStyle: { fontSize: "28pt", typeface: fontFamily, color: "hlink", underline: "sng" }, link: { uri: "https://example.com/pptx-import-reference", isExternal: true } }],
      [{ run: "Visited-theme color sample", textStyle: { fontSize: "28pt", typeface: fontFamily, color: "folHlink", underline: "sng" } }],
    ]);
    addTextBox(s, "plain-control", "Control: no link metadata", { left: 290, top: 470, width: 700, height: 72 }, { fontSize: 28, alignment: "center", verticalAlignment: "middle" }, { fill: "#FFFFFF", line: { style: "dashed", fill: palette.blue, width: 2 } });
    setNotes(s, "EDGE-04", "External hyperlink metadata versus visually identical text", ["hyperlink-runs", "plain-control"], "text preserved; link metadata may be dropped");
  }

  {
    const s = coreSlide(p, "EDGE-05", "Unsupported and approximated preset shapes");
    const geometries = ["cloud", "sun", "moon", "smileyFace", "curvedDownArrow", "leftCircularArrow", "wedgeRoundRectCallout", "cloudCallout", "ribbon", "irregularSeal1", "flowChartMagneticDisk", "actionButtonHome"];
    geometries.forEach((geometry, index) => {
      const col = index % 4;
      const row = Math.floor(index / 4);
      const left = 82 + col * 300;
      const top = 120 + row * 180;
      s.shapes.add({ geometry, name: `edge-preset-${geometry}`, position: { left, top, width: 205, height: 115 }, fill: [palette.blue, palette.orange, palette.green, palette.purple][col] + "CC", line: { style: "solid", fill: palette.navy, width: 2 } });
      addCaption(s, geometry, left - 18, top + 122, 240);
    });
    setNotes(s, "EDGE-05", "Preset geometries likely to exercise rectangle approximation and warnings", geometries.map(x => `edge-preset-${x}`), "native if supported; otherwise explicit approximation warning");
  }

  return p;
}

async function exportPreviews(presentation, prefix) {
  const dir = path.join(buildDir, `${prefix}-previews`);
  await fs.mkdir(dir, { recursive: true });
  for (let index = 0; index < presentation.slides.items.length; index++) {
    const slide = presentation.slides.items[index];
    const image = await presentation.export({ slide, format: "png", scale: 1 });
    await fs.writeFile(path.join(dir, `${String(index + 1).padStart(2, "0")}.png`), new Uint8Array(await image.arrayBuffer()));
  }
  return dir;
}

async function finalize(presentation, name, slideCount, tableSlides, chartSlides = [], injectVideo = false) {
  const candidatePath = path.join(buildDir, `${name}-candidate.pptx`);
  const finalPath = path.join(outputDir, `${name}.pptx`);
  await Promise.all([
    fs.rm(finalPath, { force: true }),
    fs.rm(candidatePath, { force: true }),
    fs.rm(path.join(buildDir, `${name}.validation.json`), { force: true }),
  ]);
  await (await PresentationFile.exportPptx(presentation)).save(candidatePath);
  if (injectVideo) execFileSync(runtimePython, [path.join(buildDir, "inject_video_cases.py"), candidatePath, videoPath]);
  const result = await finalizePresentation({
    workspaceDir,
    candidatePath,
    finalPath,
    pythonExecutable: runtimePython,
    integrityValidatorPath: path.join(SKILL_DIR, "container_tools/inspect_presentation_package_integrity.py"),
    layoutValidatorPath: path.join(SKILL_DIR, "container_tools/inspect_presentation_layout_geometry.py"),
    layoutArgs: [
      "--expected-slide-size-emu", expectedSlideSizeEmu,
      "--validate-heading-fit",
      ...tableSlides.flatMap(number => ["--require-native-table-slide", String(number)]),
    ],
    explicitTotalSlideCount: slideCount,
    requiredNativeTableOwnerSlides: tableSlides,
    requiredNativeChartOwnerSlides: chartSlides,
    ...(chartSlides.length ? { nativeChartTargetApplication: "powerpoint", materializeLiteralChartWorkbooks: true } : {}),
    fontPolicy: { basis: "design", families: [fontFamily] },
    verifyArtifactToolImport: true,
    receiptPath: path.join(buildDir, `${name}.validation.json`),
  });
  return { finalPath, result };
}

const core = await buildCore();
const boundary = await buildBoundary();
const corePreviewDir = await exportPreviews(core, "pptx-fidelity-core");
const boundaryPreviewDir = await exportPreviews(boundary, "pptx-import-boundaries");
const coreResult = await finalize(core, "pptx-fidelity-core", 15, [13], [], true);
const boundaryResult = await finalize(boundary, "pptx-import-boundaries", 5, [], [1, 2]);

console.log(JSON.stringify({ coreResult, boundaryResult, corePreviewDir, boundaryPreviewDir }, null, 2));
