import { authoringCss, KATEX_PAGE_HTML, type MeasuredNode, type MeasuredSlide } from './htmlSlides.js';

/**
 * The browser half of HTML authoring: assemble a page, walk it, measure it.
 *
 * There are two browsers that can do this — the editor's own renderer, when it
 * is open, and a headless Electron window when it is not — and they must agree
 * to the pixel, or a slide would move depending on who compiled it. So both the
 * page and the walk live here, once. `measureSlides` is called directly by the
 * renderer against an iframe's document; `measureSlidesSource` serialises the
 * very same function for `webContents.executeJavaScript`, which is why every
 * helper it uses is nested inside it rather than shared at module scope.
 */

export interface AuthoringPage {
  authored: string;
  /** `src/renderer/player/type.css`, the semantic type rules the player uses. */
  typeCss: string;
  /** The deck's own `theme.css`, as text. */
  theme: string;
  /** How an exported file links that stylesheet, so the link can be resolved here. */
  themeHref?: string;
  canvas: { w: number; h: number };
  /** What deck-relative asset paths resolve against: a `file://` or `deck://` root. */
  base: string;
}

/**
 * The page the compiler measures.
 *
 * An exported authoring file is already a complete page — canvas box, type
 * rules, its own link to the deck's `theme.css` — because it has to look like
 * the slide when the author opens it in a browser. Measuring it is therefore
 * measuring *their* document, with one change: the `<base>` is retargeted from
 * the path the file sits at to wherever this browser can reach the deck from
 * (a `file://` folder offline, the `deck:` scheme inside the editor). Nothing
 * else is injected, so what the author saw is what the deck gets.
 *
 * A hand-written fragment gets the same page built around it instead, with the
 * theme passed in as text rather than fetched.
 */
export function authoringPageHtml(page: AuthoringPage): string {
  if (/<html[\s>]/i.test(page.authored)) {
    return withKatex(inlineTheme(
      withStructuralCss(withBase(page.authored, page.base), page),
      page.themeHref,
      page.theme,
    ));
  }
  // Same order as the player: structural defaults, then the semantic type
  // fallback, then the deck's own theme, which wins.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<base href="${page.base}">
<style>${authoringCss(page.canvas)}</style>
<style>${page.typeCss}</style>
<style>${page.theme}</style>
${KATEX_PAGE_HTML}
</head>
<body>
${page.authored}
</body>
</html>
`;
}

/**
 * A document that predates the inlined KaTeX — an old export, a hand-written
 * page — must still be measured with its maths rendered, or its geometry
 * would depend on which vintage of file it came in as.
 */
function withKatex(html: string): string {
  if (html.includes('data-katex-inline')) return html;
  // Function-form replacement, and not as a nicety: the KaTeX bundle is full
  // of `$$`/`$&` sequences, which a *string* replacement would interpret as
  // replacement patterns and quietly corrupt the injected script — the maths
  // then simply never rendered, and every equation in a hand-authored full
  // document was measured at its raw-text height.
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, () => `${KATEX_PAGE_HTML}\n</head>`);
  return html;
}

/**
 * The structural rules a page cannot look like a slide without: the canvas
 * box, `box-sizing`, the semantic type fallback. An exported file carries them
 * already; a full document an author wrote from scratch does not, and without
 * them its slides measure against browser defaults — visibly, as boxes a few
 * pixels off and text at the wrong size.
 */
function withStructuralCss(html: string, page: AuthoringPage): string {
  // The selector below only ever appears inside the authoring CSS itself.
  if (html.includes('section.slide, [data-slide-id]')) return html;
  const style = `<style>${authoringCss(page.canvas)}</style>\n<style>${page.typeCss}</style>`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (open) => `${open}\n${style}`);
  }
  return html;
}

/**
 * Turn the exported file's link to `theme.css` into the stylesheet itself.
 *
 * The author's browser should fetch the deck's theme — that is what makes the
 * file look like the slide when they open it. A compile should not: fetching is
 * asynchronous, and measuring one frame too early sizes every heading at the
 * browser default and bakes that into the deck. The compiler already holds the
 * theme text, and in the editor it holds the *live* one, unsaved edits and all,
 * so it resolves the link itself and measures something deterministic.
 */
function inlineTheme(html: string, href: string | undefined, theme: string): string {
  // Function-form replacements: theme CSS may legitimately contain `$`
  // sequences, which a string replacement would treat as patterns.
  const style = `<style>${theme}</style>`;
  const name = (href ?? 'theme.css').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const link = new RegExp(`<link\\b[^>]*href=["']\\.?/?${name}["'][^>]*>`, 'i');
  if (link.test(html)) return html.replace(link, () => style);
  // No link to resolve — the deck's theme still governs the deck, so it goes
  // in last, where the author's own rules can still be more specific than it.
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, () => `${style}\n</head>`);
  return html;
}

/**
 * Point a document's `<base>` somewhere else, adding one if it has none.
 *
 * The exported file resolves its assets relative to where it is saved, which
 * is right for the author's browser and wrong everywhere else: the offline
 * compiler assembles its page in a temp folder, and the editor writes it into
 * a frame whose own URL is the editor's. Both reach the deck by a different
 * route, and this is where that route is applied.
 */
export function withBase(html: string, base: string): string {
  const tag = `<base href="${base}">`;
  if (/<base[\s>]/i.test(html)) return html.replace(/<base\b[^>]*>/i, tag);
  if (/<head[\s>]/i.test(html)) return html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${tag}`);
  return html.replace(/<html\b[^>]*>/i, (match) => `${match}\n<head>${tag}</head>`);
}

/**
 * The walk.
 *
 * A node becomes a slide object when it is a leaf of the *content* tree: media,
 * or a block that contains no further blocks. Everything above that is layout
 * — flex rows, grids, wrappers — and exists only to position its children, so
 * it contributes geometry and then disappears. That rule is what lets an agent
 * write ordinary nested markup and get flat, editable slide objects back.
 *
 * Self-contained on purpose: it is serialised with `Function.prototype
 * .toString` for the offscreen window, so a reference to anything outside this
 * body would arrive there undefined.
 */
export function measureSlides(doc: Document): MeasuredSlide[] {
  const view = doc.defaultView;
  if (!view) throw new Error('The document being measured has no window');
  const computed = (node: Element): CSSStyleDeclaration => view.getComputedStyle(node);

  const CONTENT_TAGS = new Set(['img', 'video', 'svg', 'canvas', 'table', 'iframe']);

  const found = doc.querySelectorAll<HTMLElement>('section.slide, [data-slide-id]');
  // The body fallback exists for hand-written fragments. A page with no slide
  // roots *and* nothing in its body — a scoped export whose sections were all
  // deleted — must compile to no slides, not to one empty slide made from the
  // body itself: with a scope recorded, "no sections" means "delete the range".
  const bodyHasContent = [...doc.body.children]
    .some((child) => !/^(script|style|link|template)$/i.test(child.tagName));
  const roots: HTMLElement[] = found.length > 0 ? [...found] : bodyHasContent ? [doc.body] : [];

  const isBlock = (node: HTMLElement): boolean => {
    const display = computed(node).display;
    return display !== 'inline' && display !== 'contents' && display !== 'none';
  };

  const hidden = (node: HTMLElement): boolean => {
    const style = computed(node);
    return style.display === 'none' || style.visibility === 'hidden';
  };

  /**
   * Explicitly declared, media, an exported element wrapper, or a block with
   * no content anywhere inside it. The descent matters: a row of columns of
   * leaves has content two levels down, and stopping the check at the direct
   * children made whole layout trees read as one text object — the compiled
   * slide then reflowed an entire diagram inside a single box.
   */
  const containsContent = (node: HTMLElement): boolean =>
    [...node.children].some((child) =>
      !hidden(child as HTMLElement)
      && isBlock(child as HTMLElement)
      && (isContent(child as HTMLElement) || containsContent(child as HTMLElement)));

  const isContent = (node: HTMLElement): boolean => {
    if (node.dataset.element === 'none') return false;
    // Any declared element — html, shape, image, video, unsupported — is one
    // object no matter what markup it carries inside.
    if (node.dataset.element) return true;
    const tag = node.tagName.toLowerCase();
    if (CONTENT_TAGS.has(tag)) return true;
    // A list is one object, bullets and all — splitting it into per-item text
    // boxes loses the markers and the semantics.
    if (tag === 'ul' || tag === 'ol') return true;
    if (!isBlock(node)) return false;
    // A container holding its own prose *and* block children cannot dissolve —
    // the loose text nodes would simply vanish. Kept whole, verbatim.
    if (containsContent(node)
      && [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent!.trim() !== '')) {
      node.dataset.element = 'html';
      return true;
    }
    // An exported text element carries the player's own wrappers (.text-body,
    // .text-content), which are block children; the wrapper is still the object.
    // But a hand-written wrapper *around media* — `<div class="element
    // element-video"><video …></video></div>`, copied from an export — must
    // dissolve so the media inside becomes the object; claiming the wrapper
    // would bake the video into a text element and lose it.
    if (node.classList.contains('element')) {
      return !node.querySelector(':scope > img, :scope > video');
    }
    return !containsContent(node);
  };

  /**
   * Paint that would be lost if this node dissolved as layout.
   *
   * Inline declarations are read as authored; where there are none, the
   * *computed* style answers instead, so a card styled through a class — the
   * way a front-end author actually writes one — keeps its background, border
   * and radius too. Computed values are safe here precisely because this
   * becomes a fresh synthetic shape each compile, not a stored element whose
   * literal styles must round-trip.
   */
  const boxPaint = (node: HTMLElement): Record<string, string> | null => {
    const declared = inlineDeclarationsOf(node.getAttribute('style') ?? '');
    const style = computed(node);
    const painted = (color: string | undefined): string | undefined =>
      color && color !== 'transparent' && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(color)
        ? color : undefined;
    const fill = declared['background-color']
      ?? (declared['background']?.match(/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)$/) ? declared['background'] : undefined)
      ?? painted(style.backgroundColor);
    const inlineBorder = declared['border']?.match(/^([\d.]+)px\s+\w+\s+(.+)$/);
    const computedBorderWidth = parseFloat(style.borderTopWidth || '');
    const border = inlineBorder
      ? { width: inlineBorder[1], color: inlineBorder[2] }
      : computedBorderWidth > 0 && style.borderTopStyle !== 'none' && painted(style.borderTopColor)
        ? { width: String(computedBorderWidth), color: style.borderTopColor }
        : null;
    const radius = parseFloat(declared['border-radius'] ?? style.borderTopLeftRadius ?? '');
    if (!fill && !border) return null;
    return {
      element: 'shape',
      shape: 'rect',
      ...(fill ? { fill } : {}),
      ...(border ? { stroke: border.color, strokeWidth: border.width } : { strokeWidth: '0' }),
      ...(Number.isFinite(radius) && radius > 0 ? { radius: String(radius) } : {}),
    };
  };

  const inlineDeclarationsOf = (raw: string): Record<string, string> => {
    const kept: Record<string, string> = {};
    for (const declaration of raw.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const value = declaration.slice(colon + 1).trim();
      if (value) kept[declaration.slice(0, colon).trim().toLowerCase()] = value;
    }
    return kept;
  };

  const inlineDeclarations = (node: HTMLElement, raw?: string | null): Record<string, string> => {
    const kept: Record<string, string> = {};
    for (const declaration of (raw ?? node.getAttribute('style') ?? '').split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      // Every inline declaration, as authored. Which of them are worth
      // carrying onto an element is a mapping decision, and it is made once in
      // `htmlSlides.PRESENTATIONAL_STYLE` — a second list in here would be a
      // second thing to keep in step, and the one that fell behind would drop
      // whatever it had not heard of.
      if (value) kept[property] = value;
    }
    return kept;
  };

  /**
   * Inline style the browser silently threw away.
   *
   * The compile reads declarations out of the raw `style` attribute, but the
   * browser lays the page out from its *parsed* CSSOM — and CSS error recovery
   * is silent. One unterminated quote (a regex edit truncating
   * `font-family:&quot;…&quot;` is how this was first hit) swallows every
   * declaration after it: the page measures left-aligned, the compile keeps
   * the authored `text-align`, and the apply reports success. So every styled
   * node is checked both ways — a segment that does not parse as a
   * declaration, and a declaration the CSSOM does not hold — and the mismatch
   * is reported instead of baked in.
   */
  const styleWarnings = (root: HTMLElement): string[] => {
    const describeNode = (node: Element): string => {
      const id = node.getAttribute('data-element-id') ?? node.id;
      const classes = [...node.classList].slice(0, 2).map((name) => `.${name}`).join('');
      return `<${node.tagName.toLowerCase()}${id ? `#${id}` : ''}${classes}>`;
    };
    const clip = (text: string): string => (text.length > 90 ? `${text.slice(0, 87)}…` : text);
    const out: string[] = [];
    for (const node of [root, ...root.querySelectorAll('[style]')]) {
      const raw = node.getAttribute('style');
      if (!raw || !raw.trim()) continue;
      // Split on semicolons outside quotes and parens — a data: URI or a
      // quoted font name may hold semicolons of its own — and notice a quote
      // that never closes: from there on the parser is inside a string, and
      // every later declaration is silently part of it.
      const segments: string[] = [];
      let buffer = '';
      let quote: string | null = null;
      let depth = 0;
      for (const char of raw) {
        if (quote) {
          if (char === quote) quote = null;
          buffer += char;
        } else if (char === '"' || char === "'") {
          quote = char;
          buffer += char;
        } else if (char === ';' && depth === 0) {
          segments.push(buffer);
          buffer = '';
        } else {
          if (char === '(') depth += 1;
          else if (char === ')') depth = Math.max(0, depth - 1);
          buffer += char;
        }
      }
      segments.push(buffer);
      if (quote) {
        out.push(`${describeNode(node)}: the inline style has an unterminated ${quote} quote — `
          + 'the browser ignores everything after it');
      }
      const style = (node as HTMLElement).style;
      for (const segment of segments) {
        const text = segment.trim();
        if (!text) continue;
        const colon = text.indexOf(':');
        if (colon <= 0) {
          out.push(`${describeNode(node)}: unparseable inline style segment "${clip(text)}"`);
          continue;
        }
        const property = text.slice(0, colon).trim().toLowerCase();
        if (!style || style.getPropertyValue(property)) continue;
        out.push(`${describeNode(node)}: inline declaration "${clip(text)}" was dropped by the `
          + 'browser\'s CSS parser and is not applied');
      }
    }
    return out;
  };

  const angleOf = (node: HTMLElement): number => {
    const transform = computed(node).transform;
    if (!transform || transform === 'none') return 0;
    const values = transform.match(/matrix\(([^)]+)\)/);
    if (!values) return 0;
    const [a, b] = values[1].split(',').map(Number);
    return Math.round(Math.atan2(b, a) * (180 / Math.PI) * 100) / 100;
  };

  const typeOf = (node: HTMLElement): string => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'img') return 'image';
    if (tag === 'video') return 'video';
    if (node.dataset.element === 'html' || CONTENT_TAGS.has(tag)) return 'html';
    return 'text';
  };

  const measure = (
    node: HTMLElement,
    origin: DOMRect,
    rotation: number,
    rawStyle: string | null,
  ): MeasuredNode => {
    const rect = node.getBoundingClientRect();
    const style = computed(node);
    const tag = node.tagName.toLowerCase();
    // Inline declarations only, never computed ones. A computed style is
    // mostly inherited theme values, and baking those into the element would
    // freeze the deck's typography at compile time: editing theme.css
    // afterwards would stop changing anything. What the author wrote inline is
    // a deliberate one-off and belongs on the element; everything else stays
    // where it belongs, in the stylesheet.
    // Read the raw declarations rather than the parsed CSSOM: going through
    // node.style would hand back a normalised value, turning every authored
    // #000000 into rgb(0, 0, 0) and churning the deck on every round trip.
    const kept = inlineDeclarations(node, rawStyle);

    const verbatim = node.dataset.element === 'html'
      || (CONTENT_TAGS.has(tag) && tag !== 'img' && tag !== 'video');

    return {
      tag,
      elementId: node.dataset.elementId ?? null,
      // The structural classes are the renderer's to add, not the deck's to
      // store; only the author's own classes belong in the element.
      classes: [...node.classList].filter((name) =>
        name !== 'slide' && name !== 'element' && !name.startsWith('element-')),
      dataset: { ...node.dataset } as Record<string, string>,
      rect: {
        x: rect.left - origin.left,
        y: rect.top - origin.top,
        w: rect.width,
        h: rect.height,
      },
      rotation,
      opacity: Number(style.opacity) || 1,
      style: kept,
      // A text box exported from a deck carries the player's own wrappers so
      // that it lays out identically; the deck stores only what is inside
      // them. Hand-authored markup has no such wrapper and is read whole.
      html: verbatim ? node.outerHTML
        : (node.querySelector(':scope > .text-body > [data-text-content]')
          ?? node).innerHTML,
      attrs: {
        src: node.getAttribute('src') ?? undefined,
        alt: node.getAttribute('alt') ?? undefined,
        poster: node.getAttribute('poster') ?? undefined,
        objectFit: style.objectFit || undefined,
        textAlign: style.textAlign || undefined,
        loop: node.hasAttribute('loop') || undefined,
        muted: node.hasAttribute('muted') || undefined,
        autoplay: node.hasAttribute('autoplay') || undefined,
        controls: node.hasAttribute('controls') || undefined,
      },
      verbatim,
    };
  };

  return roots.map((root) => {
    // Checked before anything below touches a node: assigning through
    // node.style re-serialises the attribute from the CSSOM, which would
    // repair the very breakage this is meant to catch.
    const warnings = styleWarnings(root);
    // Collect first, then style, then measure. The player wraps every object
    // in an element wrapper carrying the type class, and the deck's type
    // sizes hang off those classes -- so without this pass the compiler would
    // measure browser-default 16px text and bake geometry that the deck then
    // renders at 44px.
    const objects: HTMLElement[] = [];
    const synthetic = new Set<HTMLElement>();
    // A build declared on a layout container belongs to everything inside it:
    // the first baked object keeps the author's trigger and the rest appear
    // with it, so dissolving the container does not silently drop the build.
    const collect = (node: HTMLElement, build: { spec: string | null }): void => {
      for (const child of [...node.children] as HTMLElement[]) {
        if (hidden(child)) continue;
        if (isContent(child)) {
          if (!child.dataset.build && build.spec) {
            child.dataset.build = build.spec;
            build.spec = 'withPrev';
          }
          objects.push(child);
        } else {
          const scope = child.dataset.build
            ? { spec: child.dataset.build } : build;
          // Layout dissolves, but paint it carries (a card's background, a
          // panel's border) must not: it becomes a rect shape behind its
          // children, in document order so it stays underneath them.
          const paint = boxPaint(child);
          if (paint) {
            for (const [key, value] of Object.entries(paint)) child.dataset[key] = value;
            if (scope.spec) { child.dataset.build = scope.spec; scope.spec = 'withPrev'; }
            objects.push(child);
            synthetic.add(child);
          }
          collect(child, scope);
        }
      }
    };
    collect(root, { spec: null });

    root.classList.add('slide');
    for (const node of objects) {
      if (synthetic.has(node)) continue;
      // A leaf with nothing to say but paint — an empty div with a background
      // — is a rectangle, not an empty text box.
      if (!node.dataset.element && typeOf(node) === 'text' && node.textContent!.trim() === ''
        && node.children.length === 0) {
        const paint = boxPaint(node);
        if (paint) {
          for (const [key, value] of Object.entries(paint)) node.dataset[key] = value;
          synthetic.add(node);
          continue;
        }
      }
      node.classList.add('element', `element-${typeOf(node)}`);
      // HTML collapses whitespace; the deck renders text with pre-wrap. So
      // normalise here, where it still affects the measurement, rather than
      // shipping the author's source indentation into the slide as newlines.
      if (typeOf(node) === 'text' && !/^(pre|code)$/.test(node.tagName.toLowerCase())) {
        const collapsed = node.innerHTML.replace(/\s+/g, ' ').trim();
        if (collapsed !== node.innerHTML) node.innerHTML = collapsed;
      }
    }
    // Force layout with the new classes applied before anything is measured.
    void doc.body.offsetHeight;

    // Rotation is recorded, then taken off before measuring: a bounding rect
    // is axis-aligned, so a 543x1 rule at 90 degrees would otherwise measure
    // 1x543 and come back as a different shape. The deck stores the
    // *untransformed* box and rotates about its centre at render time, which
    // is exactly what the page reports with the transform removed.
    const angles = objects.map(angleOf);
    // Snapshot the style attributes first: assigning through node.style
    // re-serialises the whole attribute, which would rewrite every authored
    // #000000 as rgb(0, 0, 0) before we ever read it.
    const rawStyles = objects.map((node) => node.getAttribute('style'));
    const transforms = objects.map((node) => node.style.transform);
    for (const node of objects) node.style.transform = 'none';
    void doc.body.offsetHeight;

    const origin = root.getBoundingClientRect();
    const nodes = objects.map((node, index) => measure(node, origin, angles[index], rawStyles[index]));
    objects.forEach((node, index) => { node.style.transform = transforms[index]; });
    // A synthetic rect's paint lives on the shape itself, and the layout that
    // positioned its children died with the container: carrying either in the
    // element's inline style would paint the background twice or inset the
    // drawing by a padding that no longer has anything to pad.
    objects.forEach((node, index) => {
      if (!synthetic.has(node)) return;
      nodes[index].style = {};
      nodes[index].html = '';
    });

    // Same reasoning as element styles: an authored background keeps its
    // literal value, and only a class-driven one falls back to the computed
    // colour.
    // Inline only, exactly as for element styles: a slide whose colour comes
    // from `.slide` in theme.css must keep getting it from there. Reading the
    // computed value instead froze the theme into the deck — a title slide
    // with `color: null` and a photograph behind it came back opaque white,
    // and editing theme.css afterwards would no longer reach it.
    const authoredBackground = inlineDeclarations(root);
    const background = authoredBackground['background']
      ?? authoredBackground['background-color'] ?? null;
    // Read the authored URL, not the computed one: by the time the browser has
    // resolved it, `assets/cover.jpg` has become an absolute file:// or deck://
    // URL, and storing that in the deck would break the moment the folder moved.
    const image = (authoredBackground['background-image'] ?? '')
      .match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
    return {
      id: root.dataset.slideId ?? null,
      name: root.dataset.name ?? '',
      notes: root.dataset.notes ?? '',
      background: { color: background, image: image ? image[1] : null },
      magicMoveFromPrevious: root.dataset.magicMoveFromPrevious === 'true',
      nodes,
      warnings,
    };
  });
}

/** One text element whose content no longer fits its box, even after auto-fit. */
export interface TextOverflow {
  slideId: string | null;
  elementId: string | null;
  overflowX: boolean;
  overflowY: boolean;
  /** How far past the box the content reaches, in canvas pixels. */
  beyond: { x: number; y: number };
  /** The size auto-fit settled on, when the element opts in. */
  fittedFontSize: number | null;
}

/**
 * Find text that spills out of its box in a *built* page — the export
 * `slidesToHtml` produces, where every element already sits in the player's
 * own markup and the page carries the auto-fit script.
 *
 * This is the check the compile walk cannot make: the walk measures the
 * author's free-flowing markup, but whether a text box clips is a fact about
 * the built slide, after its box is fixed and auto-fit has settled. Auto-fit
 * is re-run here synchronously (the page's own pass runs on a later animation
 * frame), so a box that stays overflowing did so at the fit's minimum size.
 *
 * Self-contained for the same reason as `measureSlides`: it is serialised
 * into a bare offscreen window.
 */
export function measureTextOverflows(doc: Document): TextOverflow[] {
  const view = doc.defaultView;
  if (!view) throw new Error('The document being measured has no window');
  const fit = (view as unknown as {
    fitAutoTextElement?: (node: HTMLElement) => number | null;
  }).fitAutoTextElement;

  const found: TextOverflow[] = [];
  for (const root of doc.querySelectorAll<HTMLElement>('section.slide')) {
    for (const node of root.querySelectorAll<HTMLElement>('.element-text')) {
      const body = node.querySelector<HTMLElement>(':scope > .text-body');
      const content = body?.querySelector<HTMLElement>(':scope > .text-content');
      if (!body || !content) continue;
      if ((node.dataset.autofit === 'true' || node.dataset.nowrap === 'true') && fit) fit(node);
      // A condensed box squeezes horizontally with a transform, which scroll
      // sizes ignore; the fit records its scale so width can be judged as painted.
      const scaleX = Number.parseFloat(content.dataset.fittedScaleX ?? '1') || 1;
      const x = Math.round((content.scrollWidth * scaleX - body.clientWidth) * 10) / 10;
      const y = Math.round((content.scrollHeight - body.clientHeight) * 10) / 10;
      // One pixel of grace, not auto-fit's half: scroll and client sizes are
      // integer-quantised, and the fitted size is rounded to a tenth of a
      // pixel after a fit that itself tolerates half a pixel — so a correctly
      // fitted element can measure a pixel over. Real clipping (a wrapped
      // line, a cut descender row) is an order of magnitude larger.
      if (x <= 1 && y <= 1) continue;
      const fitted = content.dataset.fittedFontSize;
      found.push({
        slideId: root.dataset.slideId ?? null,
        elementId: node.dataset.elementId ?? null,
        overflowX: x > 1,
        overflowY: y > 1,
        beyond: { x: Math.max(0, x), y: Math.max(0, y) },
        fittedFontSize: fitted ? Number(fitted) : null,
      });
    }
  }
  return found;
}

/** `measureTextOverflows` as an expression a bare browser window can evaluate. */
export function measureTextOverflowsSource(): string {
  return `(${measureTextOverflows.toString()})(document)`;
}

/**
 * `measureSlides` as an expression a bare browser window can evaluate.
 *
 * The offscreen compiler is a plain Electron script with no bundler, so it
 * cannot import this module — it is handed the function's own source instead.
 * That keeps one implementation for both browsers rather than a copy that
 * quietly drifts.
 */
export function measureSlidesSource(): string {
  return `(${measureSlides.toString()})(document)`;
}
