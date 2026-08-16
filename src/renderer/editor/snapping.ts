import type { Rect } from '@shared/geometry.js';

/**
 * Alignment snapping for dragging and resizing.
 *
 * Snap candidates come from the canvas edges and centre lines plus the edges
 * and centres of every other element on the slide. Thresholds are in *canvas*
 * pixels but computed from a screen-space tolerance, so snapping feels the same
 * however far you're zoomed out.
 */

export interface SnapLine {
  axis: 'x' | 'y';
  /** Canvas coordinate of the guide. */
  at: number;
}

export interface SnapResult {
  /** The adjusted rect. */
  rect: Rect;
  /** Guides to draw, for the lines that actually took effect. */
  guides: SnapLine[];
}

/** The three interesting positions along one axis of a rect. */
function edges(r: Rect, axis: 'x' | 'y'): [number, number, number] {
  return axis === 'x'
    ? [r.x, r.x + r.w / 2, r.x + r.w]
    : [r.y, r.y + r.h / 2, r.y + r.h];
}

export function snapTargets(
  canvas: { w: number; h: number },
  others: Rect[],
  axis: 'x' | 'y',
): number[] {
  const extent = axis === 'x' ? canvas.w : canvas.h;
  const targets = [0, extent / 2, extent];
  for (const r of others) targets.push(...edges(r, axis));
  return targets;
}

/**
 * Snap a moving rect (size fixed) to nearby guides.
 *
 * Each axis is resolved independently and takes only its single closest match,
 * so a box can snap left-aligned to one neighbour and vertically centred on
 * another without the two fighting.
 */
export function snapMove(
  rect: Rect,
  canvas: { w: number; h: number },
  others: Rect[],
  threshold: number,
): SnapResult {
  const guides: SnapLine[] = [];
  const out = { ...rect };

  for (const axis of ['x', 'y'] as const) {
    const targets = snapTargets(canvas, others, axis);
    const moving = edges(rect, axis);
    let best: { delta: number; at: number } | null = null;

    for (let i = 0; i < moving.length; i++) {
      for (const target of targets) {
        const delta = target - moving[i];
        if (Math.abs(delta) > threshold) continue;
        if (!best || Math.abs(delta) < Math.abs(best.delta)) {
          best = { delta, at: target };
        }
      }
    }

    if (best) {
      if (axis === 'x') out.x += best.delta;
      else out.y += best.delta;
      guides.push({ axis, at: best.at });
    }
  }

  return { rect: out, guides };
}

/** Which edges a resize handle moves. */
export interface ResizeEdges {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

export const HANDLES: Record<string, ResizeEdges> = {
  nw: { left: true, right: false, top: true, bottom: false },
  n: { left: false, right: false, top: true, bottom: false },
  ne: { left: false, right: true, top: true, bottom: false },
  e: { left: false, right: true, top: false, bottom: false },
  se: { left: false, right: true, top: false, bottom: true },
  s: { left: false, right: false, top: false, bottom: true },
  sw: { left: true, right: false, top: false, bottom: true },
  w: { left: true, right: false, top: false, bottom: false },
};

/**
 * Snap only the edges a resize is actually moving, so dragging the right handle
 * never nudges the left one.
 */
export function snapResize(
  rect: Rect,
  edgesMoving: ResizeEdges,
  canvas: { w: number; h: number },
  others: Rect[],
  threshold: number,
  minSize = 8,
): SnapResult {
  const guides: SnapLine[] = [];
  const out = { ...rect };

  const xTargets = snapTargets(canvas, others, 'x');
  const yTargets = snapTargets(canvas, others, 'y');

  const snapEdge = (value: number, targets: number[]): { at: number } | null => {
    let best: { at: number; delta: number } | null = null;
    for (const t of targets) {
      const delta = t - value;
      if (Math.abs(delta) > threshold) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { at: t, delta };
    }
    return best;
  };

  if (edgesMoving.left) {
    const hit = snapEdge(out.x, xTargets);
    if (hit) {
      out.w += out.x - hit.at;
      out.x = hit.at;
      guides.push({ axis: 'x', at: hit.at });
    }
  }
  if (edgesMoving.right) {
    const hit = snapEdge(out.x + out.w, xTargets);
    if (hit) {
      out.w = hit.at - out.x;
      guides.push({ axis: 'x', at: hit.at });
    }
  }
  if (edgesMoving.top) {
    const hit = snapEdge(out.y, yTargets);
    if (hit) {
      out.h += out.y - hit.at;
      out.y = hit.at;
      guides.push({ axis: 'y', at: hit.at });
    }
  }
  if (edgesMoving.bottom) {
    const hit = snapEdge(out.y + out.h, yTargets);
    if (hit) {
      out.h = hit.at - out.y;
      guides.push({ axis: 'y', at: hit.at });
    }
  }

  // A snap must never invert or collapse a box; clamp and drop the guide.
  if (out.w < minSize) {
    if (edgesMoving.left) out.x = rect.x + rect.w - minSize;
    out.w = minSize;
  }
  if (out.h < minSize) {
    if (edgesMoving.top) out.y = rect.y + rect.h - minSize;
    out.h = minSize;
  }

  return { rect: out, guides };
}
