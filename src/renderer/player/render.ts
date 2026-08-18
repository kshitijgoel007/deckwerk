import { MIRRORED_TEXT_STYLE_PROPERTIES } from '@shared/deck.js';
import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import { fitScale } from '@shared/geometry.js';
import { fitAutoTextElement } from '@shared/autoFit.js';
import { quadraticPath, shapeSvg } from '@shared/shapeSvg.js';
import renderMathInElement from 'katex/contrib/auto-render';
import 'katex/dist/katex.min.css';

/**
 * deck.json -> DOM.
 *
 * This module is deliberately free of Electron and of editor state: the exact
 * same code renders the editor preview, the fullscreen present window and the
 * exported standalone bundle, so there is no chance of the three drifting apart
 * and a deck looking different on the projector than it did while authoring.
 *
 * `resolveSrc` maps a deck-relative asset path onto whatever URL scheme the
 * host needs (a `file://` URL in Electron, a plain relative path in an export).
 */
export interface RenderOptions {
  resolveSrc: (src: string) => string;
}

export { quadraticPath };
export { fitAutoTextElement };

/** Build the `<div class="slide">` for a slide, with elements absolutely placed. */
export function renderSlide(slide: Slide, opts: RenderOptions): HTMLElement {
  const root = document.createElement('div');
  root.className = `slide layout-${slide.layout ?? 'freeform'}`;
  root.dataset.slideId = slide.id;

  if (slide.background.color) root.style.background = slide.background.color;
  if (slide.background.image) {
    root.style.backgroundImage = `url("${opts.resolveSrc(slide.background.image)}")`;
    root.style.backgroundSize = 'cover';
    root.style.backgroundPosition = 'center';
  }

  // Sort by z so paint order is explicit rather than relying on array order;
  // a stable sort keeps array order as the tie-breaker.
  for (const el of [...slide.elements].sort((a, b) => a.z - b.z)) {
    root.appendChild(renderElement(el, opts));
  }
  return root;
}

/** Build the positioned wrapper for one element and fill in its type-specific body. */
export function renderElement(
  el: SlideElement,
  opts: RenderOptions,
): HTMLElement {
  const node = document.createElement('div');
  node.className = ['element', `element-${el.type}`, ...el.class].join(' ');
  node.dataset.elementId = el.id;
  node.dataset.elementType = el.type;

  const s = node.style;
  s.position = 'absolute';
  s.left = `${el.x}px`;
  s.top = `${el.y}px`;
  s.width = `${el.w}px`;
  s.height = `${el.h}px`;
  s.opacity = String(el.opacity);
  if (el.rot) s.transform = `rotate(${el.rot}deg)`;
  for (const [k, v] of Object.entries(el.style)) s.setProperty(k, v);
  if ((el.type === 'image' || el.type === 'video') && (el.borderWidth ?? 0) > 0) {
    s.border = `${el.borderWidth}px solid ${el.borderColor ?? '#000000'}`;
    s.borderRadius = `${el.borderRadius ?? 0}px`;
    s.overflow = 'hidden';
  }

  const body = renderBody(el, opts);
  if ((el.type === 'image' || el.type === 'video') && el.effects?.length) {
    const renderedEffects = renderMediaEffects(el.id, el.effects);
    body.style.filter = renderedEffects.filter;
    for (const definition of renderedEffects.definitions) node.appendChild(definition);
  }

  node.appendChild(body);
  if (el.type === 'text' && el.paragraphSpacing !== undefined) {
    node.dataset.paragraphSpacing = String(el.paragraphSpacing);
    s.setProperty('--paragraph-spacing', `${el.paragraphSpacing}px`);
  }
  if (el.type === 'text' && el.noWrap) {
    node.dataset.noWrap = 'true';
    if (el.noWrapMode === 'condense') node.dataset.fitMode = 'condense';
  }
  // noWrap implies the fit: with soft wrapping off, shrinking is the only way
  // an overlong line stays inside the box.
  if (el.type === 'text' && (el.autoFit || el.noWrap)) {
    node.dataset.autoFit = 'true';
    scheduleAutoFit(node);
  }
  return node;
}

function renderMediaEffects(
  elementId: string,
  effects: NonNullable<Extract<SlideElement, { type: 'image' }>['effects']>,
): { filter: string; definitions: SVGSVGElement[] } {
  const filters: string[] = [];
  const definitions: SVGSVGElement[] = [];
  effects.forEach((effect, index) => {
    if (effect.type === 'blur') {
      filters.push(`blur(${effect.radius}px)`);
    } else if (effect.type === 'grayscale') {
      filters.push(`grayscale(${effect.amount})`);
    } else {
      const id = `posterize-${elementId}-${index}`.replace(/[^a-zA-Z0-9_-]/g, '-');
      definitions.push(posterizeDefinition(id, effect.levels));
      filters.push(`url("#${id}")`);
    }
  });
  return { filter: filters.join(' '), definitions };
}

function posterizeDefinition(id: string, levels: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('media-effect-definition');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  const filter = document.createElementNS(ns, 'filter');
  filter.id = id;
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const transfer = document.createElementNS(ns, 'feComponentTransfer');
  const values = Array.from({ length: levels }, (_, i) => i / (levels - 1)).join(' ');
  for (const channel of ['R', 'G', 'B']) {
    const fn = document.createElementNS(ns, `feFunc${channel}`);
    fn.setAttribute('type', 'discrete');
    fn.setAttribute('tableValues', values);
    transfer.appendChild(fn);
  }
  filter.appendChild(transfer);
  svg.appendChild(filter);
  return svg;
}

const pendingTextFits = new WeakSet<HTMLElement>();
const fontRefitsRegistered = new WeakSet<HTMLElement>();

/** Fit every opted-in text element below a freshly rendered slide or stage. */
export function fitAutoText(root: ParentNode): void {
  for (const node of root.querySelectorAll<HTMLElement>('.element-text[data-auto-fit="true"]')) {
    fitAutoTextElement(node);
  }
}

/** Defer until the rendered node has been attached and therefore has layout. */
export function scheduleAutoFit(node: HTMLElement): void {
  if (pendingTextFits.has(node)) return;
  pendingTextFits.add(node);
  const run = () => {
    pendingTextFits.delete(node);
    if (node.isConnected) fitAutoTextElement(node);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);

  // Web fonts can replace fallback metrics after the first layout pass.
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts && !fontRefitsRegistered.has(node)) {
    fontRefitsRegistered.add(node);
    void fonts.ready.then(() => {
      if (node.isConnected) scheduleAutoFit(node);
    });
  }
}

function renderBody(el: SlideElement, opts: RenderOptions): HTMLElement | SVGElement {
  switch (el.type) {
    case 'text': {
      const div = document.createElement('div');
      div.className = 'text-body';
      div.style.textAlign = el.align;
      div.style.display = 'flex';
      div.style.flexDirection = 'column';
      div.style.justifyContent =
        el.valign === 'top'
          ? 'flex-start'
          : el.valign === 'bottom'
            ? 'flex-end'
            : 'center';
      div.style.width = '100%';
      div.style.height = '100%';
      // Keep vertical alignment on the outer flex box, but put all authored
      // markup inside one flow container. Otherwise every KaTeX inline span
      // becomes its own flex item and is forced onto a separate line.
      const content = document.createElement('div');
      content.className = 'text-content';
      content.style.width = '100%';
      // Element inline styles sit on the wrapper and reach the text only by
      // inheritance; a theme rule targeting .text-content directly would beat
      // them. Mirror them here so the element's own style always wins.
      for (const property of MIRRORED_TEXT_STYLE_PROPERTIES) {
        const value = el.style[property];
        if (value !== undefined) content.style.setProperty(property, value);
      }
      // KaTeX auto-render does not exclude escaped delimiter characters before
      // pairing `$...$`. Protect literal dollars, render, then restore them.
      const escapedDollar = '\uE000';
      content.innerHTML = el.html.replace(/\\\$/g, escapedDollar);
      renderMathInElement(content, {
        // Standard TeX convention: display math first so $$ is not consumed
        // as two empty inline expressions. A literal dollar is written as \$.
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
        strict: 'ignore',
      });
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode as Text;
        if (text.data.includes(escapedDollar)) {
          text.data = text.data.replaceAll(escapedDollar, '$');
        }
      }
      div.appendChild(content);
      return div;
    }

    case 'image': {
      if (/\.pdf(?:$|[?#])/i.test(el.src)) {
        const pdf = document.createElement('embed');
        pdf.src = `${opts.resolveSrc(el.src)}#page=1&toolbar=0&navpanes=0`;
        pdf.type = 'application/pdf';
        pdf.style.width = '100%';
        pdf.style.height = '100%';
        pdf.style.pointerEvents = 'none';
        return pdf;
      }
      const img = document.createElement('img');
      img.src = opts.resolveSrc(el.src);
      img.alt = el.alt;
      img.draggable = false;

      if (el.sourceBox) {
        // Cropped: the element box is a window onto a larger image, so the
        // image is positioned and sized in the window's coordinates and the
        // wrapper clips it.
        const wrap = document.createElement('div');
        wrap.style.position = 'relative';
        wrap.style.width = '100%';
        wrap.style.height = '100%';
        wrap.style.overflow = 'hidden';
        img.style.position = 'absolute';
        img.style.objectFit = 'fill';
        img.style.left = `${el.sourceBox.x}px`;
        img.style.top = `${el.sourceBox.y}px`;
        img.style.width = `${el.sourceBox.w}px`;
        img.style.height = `${el.sourceBox.h}px`;
        wrap.appendChild(img);
        return wrap;
      }

      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = el.fit;
      return img;
    }

    case 'video':
      return renderVideo(el, opts);

    case 'shape':
      return renderShape(el);

    case 'html': {
      const div = document.createElement('div');
      div.style.width = '100%';
      div.style.height = '100%';
      div.innerHTML = el.html;
      return div;
    }

    case 'unsupported': {
      // Visible on purpose: an import gap you can see and fix beats content
      // that vanished silently.
      const div = document.createElement('div');
      div.className = 'unsupported-body';
      div.textContent = el.note || el.originalType;
      return div;
    }
  }
}

function renderVideo(
  el: Extract<SlideElement, { type: 'video' }>,
  opts: RenderOptions,
): HTMLElement {
  const video = document.createElement('video');
  video.src = opts.resolveSrc(el.src);
  video.loop = el.loop;
  // Chromium refuses unmuted autoplay without a user gesture, so an unmuted
  // autoplaying video would silently never start. Muting is the only way the
  // default actually plays; sound is opt-in per element.
  video.muted = el.muted;
  video.controls = el.controls;
  video.playsInline = true;
  video.preload = 'auto';
  if (el.poster) video.poster = opts.resolveSrc(el.poster);

  // Native looping always restarts at zero, which would ignore the trim. The
  // player's runtime loops start -> end instead, so the attribute stays off
  // whenever an in-point is set.
  video.loop = el.loop && el.start <= 0 && el.end === null;

  // Autoplay is driven by the timeline runtime, not the `autoplay` attribute,
  // so that reveal-then-play ordering stays under our control.
  if (el.start > 0) {
    video.addEventListener(
      'loadedmetadata',
      () => {
        video.currentTime = el.start;
      },
      { once: true },
    );
  }

  if (el.sourceBox) {
    // Cropped: the element box is a window onto a larger frame, identical in
    // shape to how a cropped image is rendered.
    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.style.width = '100%';
    wrap.style.height = '100%';
    wrap.style.overflow = 'hidden';
    video.style.position = 'absolute';
    video.style.objectFit = 'fill';
    video.style.left = `${el.sourceBox.x}px`;
    video.style.top = `${el.sourceBox.y}px`;
    video.style.width = `${el.sourceBox.w}px`;
    video.style.height = `${el.sourceBox.h}px`;
    wrap.appendChild(video);
    return wrap;
  }

  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = el.fit;
  return video;
}

/**
 * The shape's own drawing, parsed from the one implementation in
 * `@shared/shapeSvg`. The exporter writes the same markup into the authoring
 * file, so a shape looks the same in the browser as it does on the projector.
 */
function renderShape(el: Extract<SlideElement, { type: 'shape' }>): SVGElement {
  const template = document.createElement('template');
  template.innerHTML = shapeSvg(el);
  return template.content.firstElementChild as SVGElement;
}



/**
 * Size the stage so the fixed canvas fills the viewport without cropping.
 * Everything inside the stage stays in canvas pixels.
 */
export function applyStageScale(
  stage: HTMLElement,
  deck: Deck,
  viewport: { w: number; h: number },
): number {
  const scale = fitScale(deck.canvas, viewport);
  stage.style.width = `${deck.canvas.w}px`;
  stage.style.height = `${deck.canvas.h}px`;
  stage.style.transform = `scale(${scale})`;
  stage.style.transformOrigin = 'top left';
  stage.style.position = 'absolute';
  stage.style.left = `${(viewport.w - deck.canvas.w * scale) / 2}px`;
  stage.style.top = `${(viewport.h - deck.canvas.h * scale) / 2}px`;
  return scale;
}
