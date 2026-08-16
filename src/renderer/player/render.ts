import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import { fitScale } from '@shared/geometry.js';

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

/** Build the `<div class="slide">` for a slide, with elements absolutely placed. */
export function renderSlide(slide: Slide, opts: RenderOptions): HTMLElement {
  const root = document.createElement('div');
  root.className = 'slide';
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

  node.appendChild(renderBody(el, opts));
  return node;
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
      div.innerHTML = el.html;
      return div;
    }

    case 'image': {
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

function renderShape(el: Extract<SlideElement, { type: 'shape' }>): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  // A path carries its own coordinate space; everything else is drawn directly
  // in element pixels.
  const view = el.shape === 'path' && el.pathSize ? el.pathSize : { w: el.w, h: el.h };
  svg.setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.overflow = 'visible';

  const fill = el.fill ?? 'none';
  const stroke = el.stroke ?? 'none';
  const sw = String(el.strokeWidth);
  // Insets keep a centred stroke from being clipped at the element's edge.
  const inset = el.strokeWidth / 2;

  let node: SVGElement;
  switch (el.shape) {
    case 'rect': {
      node = document.createElementNS(ns, 'rect');
      node.setAttribute('x', String(inset));
      node.setAttribute('y', String(inset));
      node.setAttribute('width', String(Math.max(0, el.w - el.strokeWidth)));
      node.setAttribute('height', String(Math.max(0, el.h - el.strokeWidth)));
      if (el.radius) node.setAttribute('rx', String(el.radius));
      break;
    }
    case 'ellipse': {
      node = document.createElementNS(ns, 'ellipse');
      node.setAttribute('cx', String(el.w / 2));
      node.setAttribute('cy', String(el.h / 2));
      node.setAttribute('rx', String(Math.max(0, el.w / 2 - inset)));
      node.setAttribute('ry', String(Math.max(0, el.h / 2 - inset)));
      break;
    }
    case 'line':
    case 'arrow': {
      node = document.createElementNS(ns, 'line');
      node.setAttribute('x1', '0');
      node.setAttribute('y1', String(el.h / 2));
      node.setAttribute('x2', String(el.w));
      node.setAttribute('y2', String(el.h / 2));
      if (el.shape === 'arrow' || el.arrowEnd || el.arrowStart) {
        const markerId = `arrowhead-${el.id}`;
        svg.appendChild(arrowMarker(ns, markerId, stroke));
        // An imported arrow says which end carries the head; a hand-drawn
        // 'arrow' shape defaults to the end.
        if (el.arrowStart) node.setAttribute('marker-start', `url(#${markerId})`);
        if (el.arrowEnd || (!el.arrowStart && el.shape === 'arrow')) {
          node.setAttribute('marker-end', `url(#${markerId})`);
        }
      }
      break;
    }
    case 'path': {
      node = document.createElementNS(ns, 'path');
      node.setAttribute('d', el.path ?? '');
      node.setAttribute('stroke-linecap', 'round');
      node.setAttribute('stroke-linejoin', 'round');
      if (el.arrowEnd || el.arrowStart) {
        const markerId = `arrowhead-${el.id}`;
        svg.appendChild(arrowMarker(ns, markerId, stroke));
        if (el.arrowEnd) node.setAttribute('marker-end', `url(#${markerId})`);
        if (el.arrowStart) node.setAttribute('marker-start', `url(#${markerId})`);
      }
      break;
    }
  }

  // Open strokes must not be flood-filled; closed shapes take their fill.
  const unfilled = el.shape === 'line' || el.shape === 'arrow';
  node.setAttribute('fill', unfilled ? 'none' : fill);
  node.setAttribute('stroke', stroke);
  node.setAttribute('stroke-width', sw);
  svg.appendChild(node);
  return svg;
}

function arrowMarker(ns: string, id: string, color: string): SVGDefsElement {
  const defs = document.createElementNS(ns, 'defs') as SVGDefsElement;
  const marker = document.createElementNS(ns, 'marker');
  marker.setAttribute('id', id);
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('refX', '5');
  marker.setAttribute('refY', '3');
  marker.setAttribute('orient', 'auto');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M0,0 L6,3 L0,6 Z');
  path.setAttribute('fill', color);
  marker.appendChild(path);
  defs.appendChild(marker);
  return defs;
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
