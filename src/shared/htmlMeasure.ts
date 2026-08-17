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
    return withKatex(inlineTheme(withBase(page.authored, page.base), page.themeHref, page.theme));
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
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${KATEX_PAGE_HTML}\n</head>`);
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
  const style = `<style>${theme}</style>`;
  const name = (href ?? 'theme.css').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const link = new RegExp(`<link\\b[^>]*href=["']\\.?/?${name}["'][^>]*>`, 'i');
  if (link.test(html)) return html.replace(link, style);
  // No link to resolve — the deck's theme still governs the deck, so it goes
  // in last, where the author's own rules can still be more specific than it.
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${style}\n</head>`);
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
  const roots: HTMLElement[] = found.length > 0 ? [...found] : [doc.body];

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
    if (CONTENT_TAGS.has(node.tagName.toLowerCase())) return true;
    if (!isBlock(node)) return false;
    // An exported text element carries the player's own wrappers (.text-body,
    // .text-content), which are block children; the wrapper is still the object.
    if (node.classList.contains('element')) return true;
    return !containsContent(node);
  };

  /** Inline paint that would be lost if this node dissolved as layout. */
  const boxPaint = (node: HTMLElement): Record<string, string> | null => {
    const declared = inlineDeclarationsOf(node.getAttribute('style') ?? '');
    const fill = declared['background-color']
      ?? (declared['background']?.match(/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)$/) ? declared['background'] : undefined);
    const border = declared['border']?.match(/^([\d.]+)px\s+\w+\s+(.+)$/);
    const radius = parseFloat(declared['border-radius'] ?? '');
    if (!fill && !border) return null;
    return {
      element: 'shape',
      shape: 'rect',
      ...(fill ? { fill } : {}),
      ...(border ? { stroke: border[2], strokeWidth: border[1] } : { strokeWidth: '0' }),
      ...(Number.isFinite(radius) ? { radius: String(radius) } : {}),
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
    };
  });
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
