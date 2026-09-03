import type { SlideElement } from './deck.js';

type MediaElement = Extract<SlideElement, { type: 'image' | 'video' }>;

export interface Size { w: number; h: number }
export interface MaskRect { x: number; y: number; w: number; h: number }

/**
 * The offset `object-position` gives a picture of `drawn` size inside `box`.
 *
 * A percentage distributes the difference between the two — which is negative
 * for `cover`, and is why `50%` centres and `0%` shows the left edge — while a
 * length is that offset outright. Anything unparseable falls back to centred,
 * which is the CSS initial value.
 */
export function objectPositionOffset(
  value: string | undefined,
  box: Size,
  drawn: Size,
): { x: number; y: number } {
  const KEYWORDS: Record<string, string> = {
    left: '0%', top: '0%', center: '50%', right: '100%', bottom: '100%',
  };
  const parts = (value ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  // `top left` and `left top` mean the same thing; a computed value is always
  // horizontal-then-vertical, and a keyword pair is only ambiguous when it
  // names an axis explicitly.
  const swap = parts.length === 2
    && ['top', 'bottom'].includes(parts[0]) && ['left', 'right'].includes(parts[1]);
  const ordered = swap ? [parts[1], parts[0]] : parts;
  const axis = (spec: string | undefined, boxSize: number, drawnSize: number): number => {
    const resolved = KEYWORDS[spec ?? ''] ?? spec ?? '50%';
    const percent = /^([+-]?[\d.]+)%$/.exec(resolved);
    if (percent) return (boxSize - drawnSize) * (Number(percent[1]) / 100);
    const length = /^([+-]?[\d.]+)px$/.exec(resolved);
    if (length) return Number(length[1]);
    return (boxSize - drawnSize) / 2;
  };
  return {
    x: axis(ordered[0], box.w, drawn.w),
    y: axis(ordered[1] ?? (ordered.length === 1 ? '50%' : undefined), box.h, drawn.h),
  };
}

/**
 * Where the picture is actually painted inside the element box, in box
 * coordinates.
 *
 * Uncropped media is placed by `object-fit`, so its painted rect is smaller
 * than the box for `contain` and larger for `cover`, and by `object-position`,
 * which is how an imported page says "this bird's head, not the middle of the
 * photograph". Cropped media already carries that rect as `sourceBox`.
 */
export function paintedMediaBox(el: MediaElement, natural: Size | null): MaskRect {
  if (el.sourceBox) return { ...el.sourceBox };
  if (!natural || natural.w <= 0 || natural.h <= 0 || el.fit === 'fill') {
    return { x: 0, y: 0, w: el.w, h: el.h };
  }
  const scale = el.fit === 'cover'
    ? Math.max(el.w / natural.w, el.h / natural.h)
    : Math.min(el.w / natural.w, el.h / natural.h);
  const w = natural.w * scale;
  const h = natural.h * scale;
  const offset = objectPositionOffset(el.style['object-position'], el, { w, h });
  return { x: offset.x, y: offset.y, w, h };
}

/**
 * The box and crop that turn a media element into a *circular* mask.
 *
 * A circular mask is drawn as `border-radius: 50%`, which only gives a true
 * circle on a square box — on a 16:9 photo it produced an ellipse. So the
 * window shrinks to the centred square of the shorter side, and the picture
 * moves into `sourceBox` at its own aspect ratio: the crop becomes circular,
 * the picture is never squashed. It keeps the scale it already had unless the
 * circle would show past its edge, in which case it grows just enough to fill.
 */
export function circularMaskLayout(
  el: MediaElement,
  natural: Size | null,
): { x: number; y: number; w: number; h: number; sourceBox: MaskRect } {
  const side = Math.max(8, Math.round(Math.min(el.w, el.h)));
  const dx = (el.w - side) / 2;
  const dy = (el.h - side) / 2;
  const painted = paintedMediaBox(el, natural);
  const aspect = natural && natural.w > 0 && natural.h > 0
    ? natural.w / natural.h
    : (painted.w > 0 && painted.h > 0 ? painted.w / painted.h : 1);

  // Undistort first: a `fill` element was painted stretched, so take the larger
  // of the two dimensions as the honest scale rather than averaging them.
  let w = Math.max(painted.w, painted.h * aspect);
  let h = w / aspect;
  const grow = Math.max(side / w, side / h, 1);
  w *= grow;
  h *= grow;

  // Keep the same part of the picture in view: the visible centre stays put.
  const cx = painted.x + painted.w / 2 - dx;
  const cy = painted.y + painted.h / 2 - dy;
  return {
    x: Math.round(el.x + dx),
    y: Math.round(el.y + dy),
    w: side,
    h: side,
    sourceBox: {
      x: Math.round(cx - w / 2),
      y: Math.round(cy - h / 2),
      w: Math.max(1, Math.round(w)),
      h: Math.max(1, Math.round(h)),
    },
  };
}

/**
 * Turn the circular mask on or off, moving the geometry with it.
 *
 * Turning it on squares the window and hands the picture to `sourceBox` so the
 * crop is a circle rather than an ellipse. Turning it off leaves that crop
 * alone: the picture itself was never altered, so there is nothing to undo.
 */
export function setCircularMask(
  el: MediaElement,
  circular: boolean,
  natural: Size | null,
): void {
  const style = { ...el.style };
  delete style['border-radius'];
  el.style = style;
  // `rect` is deliberately explicit: it prevents an old CSS 50% radius from
  // reappearing after the mask is turned off.
  el.maskShape = circular ? 'circle' : 'rect';
  if (!circular) return;
  const layout = circularMaskLayout(el, natural);
  el.x = layout.x;
  el.y = layout.y;
  el.w = layout.w;
  el.h = layout.h;
  el.sourceBox = layout.sourceBox;
}
