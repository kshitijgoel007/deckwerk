import type { AgentOperation } from './agent.js';
import { MIRRORED_TEXT_STYLE_PROPERTIES } from './deck.js';
import type { Deck, Slide, SlideElement, TimelineEntry } from './deck.js';
import { fitAutoTextElement } from './autoFit.js';
import { KATEX_AUTO_RENDER_JS, KATEX_CSS, KATEX_JS } from './katexInline.js';
import { shapeSvg } from './shapeSvg.js';

/**
 * HTML as the authoring surface for slides.
 *
 * Absolute pixel geometry is the one thing a model is genuinely bad at: it has
 * written a great deal of flexbox and almost no bounding-box arithmetic. So
 * rather than asking for coordinates, we take HTML and CSS, let a real browser
 * lay it out, and bake the geometry it computed into ordinary deck objects.
 * What comes out is not a blob — it is the same draggable, snappable,
 * Magic-Move-pairable objects you get by placing them by hand.
 *
 * This module is the pure half: the browser reports what it measured
 * (`MeasuredNode`), and everything here maps those facts onto the deck format
 * with no DOM involved, so the mapping is testable without an Electron.
 */

export interface MeasuredNode {
  /** Lowercase tag name, e.g. "h1", "img", "video", "svg". */
  tag: string;
  /** `data-element-id`, when the author kept one from a previous export. */
  elementId: string | null;
  classes: string[];
  dataset: Record<string, string>;
  /** Border box relative to the slide's top-left, in canvas pixels. */
  rect: { x: number; y: number; w: number; h: number };
  /** Clockwise degrees from the computed transform. */
  rotation: number;
  opacity: number;
  /** The node's inline declarations, as authored. Filtered on the way to an element. */
  style: Record<string, string>;
  /** innerHTML for text, outerHTML for anything preserved verbatim. */
  html: string;
  attrs: {
    src?: string;
    alt?: string;
    poster?: string;
    objectFit?: string;
    textAlign?: string;
    loop?: boolean;
    muted?: boolean;
    autoplay?: boolean;
    controls?: boolean;
  };
  /** Set by the walker when a node must be preserved as raw markup. */
  verbatim?: boolean;
}

export interface MeasuredSlide {
  id: string | null;
  name: string;
  notes: string;
  background: { color: string | null; image: string | null };
  magicMoveFromPrevious: boolean;
  nodes: MeasuredNode[];
  /**
   * Inline style the browser silently refused: a segment with no colon, or a
   * declaration the CSS parser dropped (an unterminated quote earlier in the
   * attribute swallows everything after it). Optional so measured JSON from
   * older compilers still loads.
   */
  warnings?: string[];
}

const SCOPE_MARKER = 'slide-editor-scope:';

export interface HtmlExportOptions {
  /**
   * The player's semantic type rules, inlined so the file needs nothing from
   * the editor's checkout to look right.
   */
  typeCss?: string;
  /** Where the deck folder is from wherever this file is saved. */
  base?: string;
  /** The deck's stylesheet, relative to `base`. */
  theme?: string;
}

/**
 * One editable HTML document for an authoritative range of slides.
 *
 * A whole document, not a fragment: opening it in a browser has to show the
 * slide, or the surface is a lie — the author would be editing markup whose
 * appearance they can only discover by saving it. So the file carries what
 * makes it a slide: the canvas box, the deck's own `theme.css`, the semantic
 * type rules, and a `<base>` so `assets/figure.png` resolves the same way the
 * player resolves it. The compiler measures this same document, with only the
 * base rewritten, so what the browser shows is what the deck gets.
 *
 * The marker records what was present when the file was exported. On import,
 * that lets the editor distinguish "the author deleted this slide" from "this
 * file never included that slide" without a second sidecar to lose or move.
 */
export function slidesToHtml(
  slides: Slide[],
  canvas: { w: number; h: number },
  options: HtmlExportOptions = {},
): string {
  const scope = encodeURIComponent(JSON.stringify(slides.map((slide) => slide.id)));
  const body = slides.map((slide) => slideToHtml(slide, canvas)).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!-- ${SCOPE_MARKER}${scope} -->
<title>${escape(slides.length === 1 ? slides[0].name || slides[0].id : `${slides.length} slides`)}</title>
<base href="${escape(options.base ?? '../')}">
<style>${authoringCss(canvas)}</style>
<style>${options.typeCss ?? ''}</style>
<link rel="stylesheet" href="${escape(options.theme ?? 'theme.css')}">
<style>${PREVIEW_CSS}</style>
${KATEX_PAGE_HTML}
<script>${AUTO_FIT_SCRIPT}</script>
</head>
<body>
${body}</body>
</html>
`;
}

/**
 * Reading affordances only, and only ones that cannot move anything inside a
 * slide: the page around the slides, and the space between them. The slide is
 * shown at its true 1920×1080 — the browser's own zoom is a better fit control
 * than a transform that would then have to be undone before measuring.
 */
const PREVIEW_CSS = `
  body { background: #1b1b1f; padding: 32px 0; }
  section.slide { box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5); }
  section.slide + section.slide { margin-top: 32px; }
`;

/**
 * Auto-fitting text, the one thing on a slide that static CSS cannot express.
 *
 * The player shrinks opted-in text until it fits its box; a file that does not
 * would show it overflowing, or wrapping onto a line the slide does not have.
 * So the page carries the same shrink, as a script.
 *
 * It writes the fitted sizes into a stylesheet of its own and never touches an
 * inline `style`, because inline styles are exactly what the compiler reads
 * back into the deck — a fitted size baked in there would overwrite the
 * authored one and quietly defeat auto-fitting on the next render. For the
 * same reason it is not needed at compile time at all: an element's box is
 * fixed by its own geometry, so a browser that refuses to run this (the
 * editor's frame has a strict policy) still measures identical boxes.
 */
/**
 * Maths, rendered in a page the way the player renders it at present time.
 *
 * Without this the author sees raw `$…$`, and — worse — the compiler measures
 * the raw text: a subtitle that wraps onto three unrendered lines is baked
 * three lines tall while the player draws it as two. The pass is the player's
 * own, delimiter for delimiter (see renderer/player/render.ts): protect
 * escaped dollars, auto-render, restore. Safe to run twice — rendered maths
 * leaves no delimiters behind for a second pass to match. In the exported
 * page it runs before the auto-fit script, which the head's script order
 * guarantees.
 *
 * Self-contained (no captures) because it is serialised into the exported
 * page below; the editor's frame, whose policy blocks page scripts, calls it
 * directly with its own bundled KaTeX instead.
 */
export function renderAuthoredMath(
  doc: Document,
  renderMath: (el: Element, opts: unknown) => void,
): void {
  if (!doc.body) return;
  const escapedDollar = '\uE000';
  const texts: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const text of texts) {
    if (text.data.includes('\\$')) text.data = text.data.replace(/\\\$/g, escapedDollar);
  }
  renderMath(doc.body, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
    strict: 'ignore',
  });
  const restore = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  while (restore.nextNode()) {
    const text = restore.currentNode as Text;
    if (text.data.includes(escapedDollar)) {
      text.data = text.data.replaceAll(escapedDollar, '$');
    }
  }
}

/** A closing script tag inside an inlined library would end the tag early. */
function escapeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/**
 * KaTeX, carried inside the page. The exported file must render its maths in
 * whatever browser opens it — the author's, the editor's offscreen iframe, the
 * headless compile window — offline, with no node_modules in reach, and all of
 * them must agree with the player. Marked so a measuring page can tell whether
 * the document already carries it.
 */
export const KATEX_PAGE_HTML = `<style data-katex-inline>${KATEX_CSS}</style>
<script>${escapeInlineScript(KATEX_JS)}</script>
<script>${escapeInlineScript(KATEX_AUTO_RENDER_JS)}</script>
<script>${renderAuthoredMath.toString()}
(() => {
  const run = () => {
    const render = globalThis.renderMathInElement;
    if (render) renderAuthoredMath(document, render);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();</script>`;

const AUTO_FIT_SCRIPT = `
${fitAutoTextElement.toString()}
(() => {
  const fit = () => {
    for (const node of document.querySelectorAll('[data-autofit="true"], [data-nowrap="true"]')) {
      fitAutoTextElement(node);
    }
  };
  const run = () => requestAnimationFrame(fit);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  // Web fonts replace fallback metrics after the first layout, exactly as they
  // do in the player, and a fit measured against the wrong metrics is wrong.
  if (document.fonts) document.fonts.ready.then(run);
})();
`;

/**
 * What makes a slide a slide, before any theme is involved.
 *
 * Deliberately *not* the player's stylesheet: that absolutely positions every
 * object, which is exactly what must not happen while the author's flexbox and
 * grid are doing the work. All this establishes is the canvas box and a
 * containing block for anything the author does position by hand.
 */
export function authoringCss(canvas: { w: number; h: number }): string {
  return `
  html, body { margin: 0; padding: 0; }
  body { width: ${canvas.w}px; }
  section.slide, [data-slide-id] {
    position: relative;
    width: ${canvas.w}px;
    height: ${canvas.h}px;
    overflow: hidden;
    box-sizing: border-box;
  }
  /* Sensible defaults so bare markup does not arrive with browser margins
     baked into its measured geometry. */
  h1, h2, h3, h4, h5, h6, p, ul, ol, figure, blockquote { margin: 0; }
  /* No max-width: a picture that bleeds past the canvas edge is a real design,
     and clamping it to the slide silently resizes the object. The slide clips
     what overflows, which is what the player does too. */
  img, video { display: block; }
`;
}

/** Read the original ordered scope from an exported HTML document. */
export function htmlSlideScope(html: string): string[] | null {
  const match = html.match(/<!--\s*slide-editor-scope:([^\s]+)\s*-->/);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(match[1]));
    return Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : null;
  } catch {
    return null;
  }
}

/**
 * Write the ids a compile assigned back into the authored document.
 *
 * A section without a `data-slide-id` is minted a fresh id on *every* compile,
 * so a file that is saved twice — or applied once, timed out, and applied
 * again — would insert its new slides twice. Stamping the assigned ids into
 * the file after a successful sync is what makes the loop idempotent: from
 * then on the same sections replace the same slides, however many times the
 * file lands. The scope marker is rewritten to the file's current slides for
 * the same reason — it is the record of what this file now governs.
 *
 * Returns null when there is nothing to change or when the document cannot be
 * matched against the compiled slides (better to leave a strange file alone
 * than to stamp ids onto the wrong sections).
 */
export function adoptAuthoredIds(html: string, slides: Slide[]): string | null {
  // Only the body can hold slide roots, and the head carries inlined KaTeX
  // whose script text must not be mistaken for markup.
  const bodyAt = html.search(/<body[\s>]/i);
  const from = bodyAt >= 0 ? bodyAt : 0;
  const roots = [...html.slice(from).matchAll(/<[a-zA-Z][^>]*>/g)]
    .map((match) => ({ tag: match[0], at: from + (match.index ?? 0) }))
    .filter(({ tag }) => /\bdata-slide-id\s*=/.test(tag)
      || (/^<section\b/i.test(tag) && /\bclass\s*=\s*["'][^"']*\bslide\b/.test(tag)));
  if (roots.length !== slides.length) return null;

  let out = html;
  for (let i = roots.length - 1; i >= 0; i--) {
    const { tag, at } = roots[i];
    if (/\bdata-slide-id\s*=/.test(tag)) continue;
    const stamped = tag.replace(/^<section\b/i,
      (open) => `${open} data-slide-id="${escape(slides[i].id)}"`);
    out = out.slice(0, at) + stamped + out.slice(at + tag.length);
  }

  const scope = `<!-- ${SCOPE_MARKER}${encodeURIComponent(JSON.stringify(slides.map((slide) => slide.id)))} -->`;
  const marker = /<!--\s*slide-editor-scope:[^\s]+\s*-->/;
  if (marker.test(out)) out = out.replace(marker, scope);
  else if (/<head[\s>]/i.test(out)) out = out.replace(/<head\b[^>]*>/i, (open) => `${open}\n${scope}`);
  else out = `${scope}\n${out}`;

  return out === html ? null : out;
}

/**
 * Build the ordinary transaction that makes an exported HTML scope authoritative.
 * Files without a scope marker retain replace-or-append behaviour, so older
 * exports and hand-authored snippets remain valid.
 */
export function htmlSyncOperations(
  deck: Deck,
  slides: Slide[],
  scope: string[] | null,
  after: string | null,
): AgentOperation[] {
  const existingIds = new Set(deck.slides.map((slide) => slide.id));
  const authoredIds = slides.map((slide) => slide.id);
  if (new Set(authoredIds).size !== authoredIds.length) {
    throw new Error('HTML contains duplicate slide ids');
  }

  if (scope === null) {
    const operations: AgentOperation[] = [];
    const inserted: Slide[] = [];
    for (const slide of slides) {
      if (existingIds.has(slide.id)) operations.push({ op: 'replaceSlide', slideId: slide.id, slide });
      else inserted.push(slide);
    }
    if (inserted.length > 0) operations.push({ op: 'insertSlides', afterSlideId: after, slides: inserted });
    return operations;
  }

  if (new Set(scope).size !== scope.length) throw new Error('HTML scope contains duplicate slide ids');
  const unknownScope = scope.find((id) => !existingIds.has(id));
  if (unknownScope) throw new Error(`HTML scope names unknown slide id: ${unknownScope}`);

  // What the file governs is what it was exported with *plus* whatever it has
  // since created. Without that second half the loop only works once: a save
  // that adds a slide makes the very next save of the same file look like an
  // attempt to take over a slide belonging to someone else.
  const scopeSet = new Set([...scope, ...authoredIds.filter((id) => existingIds.has(id))]);
  // Deletion stays keyed to the recorded scope alone: a slide is deleted
  // because it was exported and then removed, never because it is merely absent.
  const exported = new Set(scope);

  const positions = [...scopeSet]
    .map((id) => deck.slides.findIndex((slide) => slide.id === id))
    .filter((index) => index >= 0);
  const insertionIndex = Math.min(...positions);
  const outside = deck.slides.map((slide) => slide.id).filter((id) => !scopeSet.has(id));
  const target = [...outside];
  target.splice(Number.isFinite(insertionIndex) ? insertionIndex : target.length, 0, ...authoredIds);
  if (target.length === 0) throw new Error('An HTML edit cannot delete every slide in the deck');

  const operations: AgentOperation[] = [];
  for (const slide of slides) {
    if (existingIds.has(slide.id)) operations.push({ op: 'replaceSlide', slideId: slide.id, slide });
  }

  const inserted = slides.filter((slide) => !existingIds.has(slide.id));
  // Insert before deleting so replacing the entire scope with new slides never
  // transiently violates the invariant that a deck retains at least one slide.
  if (inserted.length > 0) {
    operations.push({
      op: 'insertSlides',
      afterSlideId: deck.slides[deck.slides.length - 1]?.id ?? null,
      slides: inserted,
    });
  }
  for (const id of exported) {
    if (!authoredIds.includes(id)) operations.push({ op: 'deleteSlide', slideId: id });
  }

  const current = deck.slides.map((slide) => slide.id)
    .filter((id) => !scopeSet.has(id) || authoredIds.includes(id))
    .concat(inserted.map((slide) => slide.id));
  if (current.join('\0') !== target.join('\0')) {
    target.forEach((id, index) => operations.push({
      op: 'moveSlide', slideId: id, afterSlideId: index === 0 ? null : target[index - 1],
    }));
  }
  return operations;
}

/**
 * Inline CSS worth keeping once an element is absolutely positioned.
 *
 * Layout declarations — display, flex, grid, margins — did their job during
 * measurement and are actively harmful afterwards: `flex: 1` is inert on an
 * absolutely positioned box, and a stray `display: flex` would re-flow text
 * the geometry was measured against. Presentation survives; layout does not.
 */
export const PRESENTATIONAL_STYLE = new Set([
  'color', 'background', 'background-color', 'background-image',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'letter-spacing', 'line-height', 'text-transform', 'text-decoration',
  'background-size', 'background-position', 'background-repeat',
  // Gradient text is background-image + background-clip + a transparent fill.
  // Drop the clip and the "gradient" is a solid box over the words.
  'background-clip', '-webkit-background-clip', '-webkit-text-fill-color',
  'text-shadow', 'border', 'border-radius', 'border-color', 'border-width',
  'border-style', 'box-shadow', 'filter', 'mix-blend-mode', 'padding',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
]);

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'li', 'span', 'div', 'figcaption', 'pre', 'code', 'ul', 'ol']);

/**
 * Turn a measured page into deck slides, against the deck they are destined for.
 *
 * Ids are minted only where the markup carries none, and an id being
 * re-authored is not a clash with itself: the ids belonging to slides this
 * compile is about to replace are freed first, or every round trip would
 * rename every element it touched.
 */
export function slidesFromMeasured(deck: Deck, measured: MeasuredSlide[]): Slide[] {
  const used = new Set(deck.slides.flatMap((slide) =>
    [slide.id, ...slide.elements.map((element) => element.id)]));
  for (const slide of measured) {
    const existing = deck.slides.find((candidate) => candidate.id === slide.id);
    if (!existing) continue;
    used.delete(existing.id);
    for (const element of existing.elements) used.delete(element.id);
  }

  return measured.map((slide, index) => slideFromMeasured(slide, {
    slideId: slide.id ?? nextSlideId(used, index),
    usedIds: used,
  }));
}

function nextSlideId(used: Set<string>, index: number): string {
  let candidate = `slide-${used.size + index + 1}`;
  for (let n = 1; used.has(candidate); n++) candidate = `slide-${used.size + index + 1}-${n}`;
  return candidate;
}

/** Turn one measured slide into a deck slide, ids minted where absent. */
export function slideFromMeasured(
  measured: MeasuredSlide,
  opts: { slideId: string; usedIds: Set<string> },
): Slide {
  const timeline: TimelineEntry[] = [];
  const elements: SlideElement[] = [];

  measured.nodes.forEach((node, index) => {
    const id = uniqueId(node.elementId ?? `${opts.slideId}-${node.tag}-${index + 1}`, opts.usedIds);
    const element = elementFromNode(node, id, index + 1);
    if (!element) return;
    elements.push(element);
    const build = buildFromNode(node, id, timeline.length);
    if (build) timeline.push(build);
  });

  return {
    id: opts.slideId,
    name: measured.name,
    notes: measured.notes,
    background: measured.background,
    ...(measured.magicMoveFromPrevious ? { magicMoveFromPrevious: true } : {}),
    elements,
    timeline,
  };
}

export function elementFromNode(
  node: MeasuredNode,
  id: string,
  z: number,
): SlideElement | null {
  if (node.rect.w <= 0 || node.rect.h <= 0) return null;

  const base = {
    id,
    x: round(node.rect.x),
    y: round(node.rect.y),
    w: round(node.rect.w),
    h: round(node.rect.h),
    rot: round(node.rotation),
    z,
    opacity: node.opacity,
    class: node.classes,
    style: pickStyle(node.style),
    ...(node.dataset.magicMove ? { magicMoveId: node.dataset.magicMove } : {}),
  };

  // A cropped picture is exported as a window with the media inside it, the
  // way the player renders one, so the wrapper — not the `<img>` — is the
  // object, and it says what it is rather than being guessed from its tag.
  if (node.dataset.element === 'image' || node.dataset.element === 'video') {
    const common = {
      ...base,
      src: node.dataset.src ?? '',
      fit: fitFrom(node.dataset.fit),
      sourceBox: cropFrom(node.dataset.crop),
    };
    if (node.dataset.element === 'image') {
      return { ...common, type: 'image', alt: node.dataset.alt ?? '' };
    }
    const [start, end] = trimFrom(node.dataset.trim);
    return {
      ...common,
      type: 'video',
      autoplay: node.dataset.autoplay === 'true',
      loop: node.dataset.loop === 'true',
      muted: node.dataset.muted === 'true',
      controls: node.dataset.controls === 'true',
      start,
      end,
      poster: node.dataset.poster ?? null,
    };
  }

  if (node.tag === 'img') {
    return {
      ...base,
      type: 'image',
      src: node.attrs.src ?? '',
      fit: fitFrom(node.attrs.objectFit),
      alt: node.attrs.alt ?? '',
      sourceBox: cropFrom(node.dataset.crop),
    };
  }

  if (node.tag === 'video') {
    const [start, end] = trimFrom(node.dataset.trim);
    return {
      ...base,
      type: 'video',
      src: withoutFragment(node.attrs.src ?? ''),
      fit: fitFrom(node.attrs.objectFit),
      autoplay: node.attrs.autoplay ?? true,
      loop: node.attrs.loop ?? true,
      muted: node.attrs.muted ?? true,
      controls: node.attrs.controls ?? false,
      start,
      end,
      poster: node.attrs.poster ?? null,
      sourceBox: cropFrom(node.dataset.crop),
    };
  }

  if (node.dataset.element === 'shape') {
    const [cx, cy] = numbers(node.dataset.control);
    const [pw, ph] = numbers(node.dataset.pathSize);
    return {
      ...base,
      type: 'shape',
      shape: shapeKind(node.dataset.shape),
      fill: node.dataset.fill ?? null,
      stroke: node.dataset.stroke ?? null,
      strokeWidth: Number(node.dataset.strokeWidth ?? 2) || 0,
      radius: Number(node.dataset.radius ?? 0) || 0,
      path: node.dataset.path ?? null,
      pathSize: pw > 0 && ph > 0 ? { w: pw, h: ph } : null,
      arrowStart: node.dataset.arrowStart === 'true',
      arrowEnd: node.dataset.arrowEnd === 'true',
      ...(node.dataset.control ? { control: { x: cx, y: cy } } : {}),
    };
  }

  if (node.dataset.element === 'unsupported') {
    // Still a gap, still conspicuous. It only stops being one when the author
    // replaces this element with markup that means something.
    return {
      ...base,
      type: 'unsupported',
      originalType: node.dataset.originalType ?? 'unknown',
      note: node.html.replace(/<[^>]*>/g, '').trim(),
    };
  }

  // Anything the walker could not reduce to a known object — an inline SVG
  // chart, a gradient panel, a table — is preserved verbatim rather than
  // dropped or flattened to a picture. It still drags and resizes; only its
  // innards are not individually editable.
  if (node.verbatim || node.dataset.element === 'html' || !TEXT_TAGS.has(node.tag)) {
    return { ...base, type: 'html', html: node.html };
  }

  return {
    ...base,
    type: 'text',
    // A list is one text object; without its own tag around the items the
    // markers and indentation would not survive into the deck.
    html: node.tag === 'ul' || node.tag === 'ol'
      ? `<${node.tag}>${node.html.trim()}</${node.tag}>`
      : node.html.trim(),
    align: alignFrom(node.attrs.textAlign),
    valign: valignFrom(node.dataset.valign),
    ...(node.dataset.autofit !== undefined ? { autoFit: node.dataset.autofit !== 'false' } : {}),
    ...(node.dataset.nowrap !== undefined ? { noWrap: node.dataset.nowrap !== 'false' } : {}),
    ...(node.dataset.fitMode === 'condense' ? { noWrapMode: 'condense' as const } : {}),
    ...(Number.isFinite(Number.parseFloat(node.dataset.paragraphSpacing ?? ''))
      ? { paragraphSpacing: Math.max(0, Number.parseFloat(node.dataset.paragraphSpacing!)) }
      : {}),
  };
}

/**
 * `data-build="click"`, `data-build="afterPrev"`, `data-build="afterPrev+500"`.
 *
 * Builds have no CSS analogue, so they ride on data attributes rather than in
 * a side-channel the author has to keep in sync with the markup.
 */
export function buildFromNode(
  node: MeasuredNode,
  elementId: string,
  index: number,
): TimelineEntry | null {
  const spec = node.dataset.build;
  if (!spec) return null;
  const [name, delay] = spec.split('+');
  const on = (['click', 'afterPrev', 'withPrev', 'mediaEnd'] as const)
    .find((candidate) => candidate.toLowerCase() === name.trim().toLowerCase());
  if (!on) return null;
  return {
    id: `${elementId}-build-${index + 1}`,
    trigger: { on, ref: node.dataset.buildRef ?? null, delay: Number(delay ?? 0) || 0 },
    action: { type: 'appear', target: elementId, value: null },
  };
}

/**
 * A slide as HTML an agent can edit and hand back.
 *
 * Positions are emitted as inline CSS so the export is lossless: recompiling
 * an untouched export reproduces the slide. Replace those rules with flexbox
 * or grid and the compiler will measure whatever the browser makes of it.
 */
export function slideToHtml(slide: Slide, canvas: { w: number; h: number }): string {
  const builds = new Map(slide.timeline
    .filter((entry) => entry.action.type === 'appear')
    .map((entry) => [entry.action.target, entry]));

  const body = [...slide.elements]
    .sort((a, b) => a.z - b.z)
    .map((element) => elementToHtml(element, builds.get(element.id)))
    .join('\n');

  // Both halves, and as separate declarations rather than the `background`
  // shorthand: the shorthand would need parsing back out, and a slide that has
  // a picture behind it is not one whose background can be summarised as a
  // colour. Sizing matches what the player does with the same two fields.
  const declarations = [
    slide.background.color ? `background-color:${slide.background.color}` : '',
    slide.background.image
      ? `background-image:url("${escape(slide.background.image)}")`
        + '; background-size:cover; background-position:center'
      : '',
  ].filter(Boolean).join('; ');
  const background = declarations ? ` ${styleAttr(declarations)}` : '';
  return `<section class="slide" data-slide-id="${escape(slide.id)}"`
    + ` data-canvas="${canvas.w}x${canvas.h}"`
    + (slide.name ? ` data-name="${escape(slide.name)}"` : '')
    + (slide.magicMoveFromPrevious ? ' data-magic-move-from-previous="true"' : '')
    + `${background}>\n${body}\n</section>\n`;
}

function elementToHtml(element: SlideElement, build?: TimelineEntry): string {
  const position = `position:absolute; left:${element.x}px; top:${element.y}px;`
    + ` width:${element.w}px; height:${element.h}px;`
    + (element.rot ? ` transform:rotate(${element.rot}deg);` : '')
    + (element.opacity !== 1 ? ` opacity:${element.opacity};` : '');
  const inline = Object.entries(element.style)
    .map(([property, value]) => ` ${property}:${value};`)
    .join('');
  const attrs = [
    `data-element-id="${escape(element.id)}"`,
    // Text writes its own class attribute, because it also carries the
    // player's structural classes.
    element.class.length > 0 && element.type !== 'text'
      ? `class="${escape(element.class.join(' '))}"` : '',
    element.magicMoveId ? `data-magic-move="${escape(element.magicMoveId)}"` : '',
    build ? `data-build="${build.trigger.on}${build.trigger.delay ? `+${build.trigger.delay}` : ''}"` : '',
  ].filter(Boolean).join(' ');

  switch (element.type) {
    case 'text': {
      // The player's own markup: a flex body for vertical alignment wrapping a
      // content block that holds all the text. Reproduced rather than
      // approximated, because a flatter box lays out subtly differently and
      // auto-fit then settles on a different size — which is a title that fits
      // on the projector and wraps onto a third line in the browser.
      //
      // Vertical alignment also travels as an attribute: it has no CSS
      // equivalent once a box is measured tightly around its content.
      const justify = element.valign === 'top' ? 'flex-start'
        : element.valign === 'bottom' ? 'flex-end' : 'center';
      const body = `<div class="text-body" data-element="none" `
        + styleAttr(`display:flex; flex-direction:column; justify-content:${justify};`,
          'width:100%; height:100%;')
        // Inheritable inline styles are mirrored onto the content node so a
        // theme rule targeting .text-content directly can't override them
        // (matches the live renderer — see MIRRORED_TEXT_STYLE_PROPERTIES).
        + `><div class="text-content" data-text-content ${styleAttr('width:100%;',
          MIRRORED_TEXT_STYLE_PROPERTIES
            .filter((property) => element.style[property] !== undefined)
            .map((property) => `${property}:${element.style[property]};`)
            .join(' '))}>`
        + `${element.html}</div></div>`;
      return `  <div ${attrs} class="element element-text${element.class.length > 0
        ? ` ${escape(element.class.join(' '))}` : ''}" data-valign="${element.valign}"`
        + `${element.autoFit ? ' data-autofit="true"' : ''}`
        + `${element.noWrap ? ' data-nowrap="true"' : ''}`
        + `${element.noWrap && element.noWrapMode === 'condense' ? ' data-fit-mode="condense"' : ''}`
        + `${element.paragraphSpacing !== undefined
          ? ` data-paragraph-spacing="${element.paragraphSpacing}"` : ''}`
        + ` ${styleAttr(position, inline, `text-align:${element.align};`,
          element.paragraphSpacing !== undefined
            ? `--paragraph-spacing:${element.paragraphSpacing}px;` : '')}>${body}</div>`;
    }
    case 'image':
      if (element.sourceBox) {
        return `  <div ${attrs} data-element="image"`
          + ` data-src="${escape(element.src)}" data-alt="${escape(element.alt)}"`
          + ` data-fit="${element.fit}" data-crop="${boxAttr(element.sourceBox)}"`
          + ` ${styleAttr(position, inline, media(element), 'overflow:hidden;')}>`
          + `${notAnObject(croppedMedia('img', element.src, element.sourceBox,
            ` alt="${escape(element.alt)}"`))}</div>`;
      }
      return `  <img ${attrs} src="${escape(element.src)}" alt="${escape(element.alt)}"`
        + ` ${styleAttr(position, inline, media(element), `object-fit:${element.fit};`)}>`;
    case 'video': {
      const flags = `${element.loop ? ' loop' : ''}${element.muted ? ' muted' : ''}`
        + `${element.autoplay ? ' autoplay' : ''}${element.controls ? ' controls' : ''}`;
      const trim = ` data-trim="${element.start},${element.end ?? ''}"`;
      if (element.sourceBox) {
        return `  <div ${attrs} data-element="video"`
          + ` data-src="${escape(element.src)}" data-fit="${element.fit}"${trim}`
          + ` data-crop="${boxAttr(element.sourceBox)}"`
          + `${element.loop ? ' data-loop="true"' : ''}`
          + `${element.muted ? ' data-muted="true"' : ''}`
          + `${element.autoplay ? ' data-autoplay="true"' : ''}`
          + `${element.controls ? ' data-controls="true"' : ''}`
          + `${element.poster ? ` data-poster="${escape(element.poster)}"` : ''}`
          + ` ${styleAttr(position, inline, media(element), 'overflow:hidden;')}>`
          + `${notAnObject(croppedMedia('video', mediaFragment(element), element.sourceBox, flags))}</div>`;
      }
      // `#t=` is how a static page asks for the in-point: without it the file
      // shows frame zero while the player shows the frame the talk starts on.
      return `  <video ${attrs} src="${escape(mediaFragment(element))}"${trim}${flags}`
        + `${element.poster ? ` poster="${escape(element.poster)}"` : ''}`
        + ` ${styleAttr(position, inline, media(element), `object-fit:${element.fit};`)}></video>`;
    }
    case 'shape':
      // A shape has no markup of its own, so its parameters ride on data
      // attributes: readable, editable by hand, and reconstructed exactly on
      // the way back rather than being flattened into a picture.
      return `  <div ${attrs} data-element="shape" data-shape="${element.shape}"`
        + attr('data-fill', element.fill)
        + attr('data-stroke', element.stroke)
        + ` data-stroke-width="${element.strokeWidth}" data-radius="${element.radius}"`
        + (element.arrowStart ? ' data-arrow-start="true"' : '')
        + (element.arrowEnd ? ' data-arrow-end="true"' : '')
        + (element.control ? ` data-control="${element.control.x},${element.control.y}"` : '')
        + attr('data-path', element.path)
        + (element.pathSize ? ` data-path-size="${element.pathSize.w},${element.pathSize.h}"` : '')
        + ` ${styleAttr(position, inline)}>`
        // The drawing itself, from the same builder the player draws with. It
        // is marked as not-an-object so the walk keeps treating the wrapper as
        // the shape and reads the parameters off the data attributes above,
        // rather than descending into the SVG and calling it an html element.
        + `${notAnObject(shapeSvg(element))}</div>`;
    case 'unsupported':
      // An import gap, described well enough to be fixed: replace this element
      // with real markup and it becomes a real object on the way back.
      return `  <div ${attrs} data-element="unsupported"`
        + ` data-original-type="${escape(element.originalType)}"`
        + ` ${styleAttr(position, inline)}>${escape(element.note)}</div>`;
    default:
      return `  <div ${attrs} data-element="html" ${styleAttr(position, inline)}>`
        + `${'html' in element ? element.html : ''}</div>`;
  }
}

/**
 * Mark markup as scenery: it is drawn, but it is not a slide object.
 *
 * The walk turns content leaves into objects, so an SVG or an `<img>` placed
 * inside an element purely to render it would otherwise *become* the element
 * and take its identity with it.
 */
function notAnObject(markup: string): string {
  return markup.replace(/^<([a-z]+)/i, '<$1 data-element="none"');
}

/**
 * A crop, drawn the way the player draws it: the element box is a window and
 * the picture is placed and sized behind it in the window's coordinates. The
 * naive alternative — squeezing the whole frame into the window with
 * `object-fit` — is how a cropped photograph came out visibly squashed.
 */
function croppedMedia(
  tag: 'img' | 'video',
  src: string,
  box: { x: number; y: number; w: number; h: number },
  extra: string,
): string {
  const close = tag === 'video' ? '</video>' : '';
  return `<${tag} src="${escape(src)}"${extra} `
    + styleAttr(`position:absolute; left:${box.x}px; top:${box.y}px;`,
      `width:${box.w}px; height:${box.h}px; object-fit:fill;`)
    + `>${close}`;
}

/** The video's source at its in-point, so a trimmed clip previews where it starts. */
function mediaFragment(element: Extract<SlideElement, { type: 'video' }>): string {
  return element.start > 0 ? `${element.src}#t=${element.start}` : element.src;
}

/** Border and effects, which the player puts on the element wrapper. */
function media(element: SlideElement): string {
  if (element.type !== 'image' && element.type !== 'video') return '';
  const border = (element.borderWidth ?? 0) > 0
    ? `border:${element.borderWidth}px solid ${element.borderColor ?? '#000000'};`
      + ` border-radius:${element.borderRadius ?? 0}px; overflow:hidden;`
    : '';
  // Posterise is an SVG filter the player defines per element; blur and
  // greyscale are plain CSS. Only the CSS pair is reproduced here, so a
  // posterised picture previews unposterised — visible, and not data loss.
  const filters = (element.effects ?? [])
    .map((effect) => effect.type === 'blur' ? `blur(${effect.radius}px)`
      : effect.type === 'grayscale' ? `grayscale(${effect.amount})` : '')
    .filter(Boolean)
    .join(' ');
  return border + (filters ? ` filter:${filters};` : '');
}

/**
 * A `style` attribute, escaped.
 *
 * Not decoration: a font stack is `font-family:"Helvetica Neue", sans-serif`,
 * and dropping that into `style="…"` unescaped ends the attribute at the first
 * quote. Everything after it — the colour, the weight, the alignment appended
 * at the end — is silently discarded, and the slide comes back in the browser's
 * default face. Every Keynote import has quoted font stacks on nearly every
 * text box, so this was most of a deck.
 */
function styleAttr(...declarations: string[]): string {
  return `style="${escape(declarations.filter(Boolean).join(' ').trim())}"`;
}

function attr(name: string, value: string | null): string {
  return value === null || value === '' ? '' : ` ${name}="${escape(value)}"`;
}

/* --- small conversions --- */

function pickStyle(style: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [property, value] of Object.entries(style)) {
    if (PRESENTATIONAL_STYLE.has(property) && value) kept[property] = value;
  }
  return kept;
}

function valignFrom(value: string | undefined): 'top' | 'middle' | 'bottom' {
  return value === 'middle' || value === 'bottom' ? value : 'top';
}

function shapeKind(value: string | undefined): 'rect' | 'ellipse' | 'line' | 'arrow' | 'path' {
  const kinds = ['rect', 'ellipse', 'line', 'arrow', 'path'] as const;
  return kinds.find((kind) => kind === value) ?? 'rect';
}

function numbers(spec: string | undefined): [number, number] {
  const [a, b] = (spec ?? '').split(',').map((part) => Number(part.trim()));
  return [Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0];
}

function fitFrom(objectFit: string | undefined): 'contain' | 'cover' | 'fill' {
  return objectFit === 'cover' || objectFit === 'fill' ? objectFit : 'contain';
}

function alignFrom(textAlign: string | undefined): 'left' | 'center' | 'right' | 'justify' {
  if (textAlign === 'center' || textAlign === 'right' || textAlign === 'justify') return textAlign;
  // `start`/`end` resolve to left in the left-to-right decks this supports.
  return 'left';
}

function trimFrom(spec: string | undefined): [number, number | null] {
  if (!spec) return [0, null];
  const [start, end] = spec.split(',').map((part) => part.trim());
  const from = Number(start);
  const to = end === '' || end === undefined ? null : Number(end);
  return [Number.isFinite(from) ? from : 0, to !== null && Number.isFinite(to) ? to : null];
}

function cropFrom(spec: string | undefined) {
  if (!spec) return null;
  const parts = spec.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [x, y, w, h] = parts;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** `assets/clip.mp4#t=12` is a request for a frame, not a different file. */
function withoutFragment(src: string): string {
  return src.replace(/#t=[^#]*$/, '');
}

function boxAttr(box: { x: number; y: number; w: number; h: number }): string {
  return `${box.x},${box.y},${box.w},${box.h}`;
}

export function uniqueId(preferred: string, used: Set<string>): string {
  const base = preferred.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'element';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
