import type { Rect } from '@shared/geometry.js';

/**
 * Alignment, spacing and sizing guides for dragging and resizing.
 *
 * Alignment snap candidates come from the canvas edges and centre lines plus
 * the edges and centres of every other element on the slide. On top of that a
 * move can snap so the gaps around it match the gaps between its neighbours
 * (distribution), and a resize can snap its width or height to match another
 * element's. Thresholds are in *canvas* pixels but computed from a screen-space
 * tolerance, so snapping feels the same however far you're zoomed out.
 */

export interface SnapLine {
  axis: 'x' | 'y';
  /** Canvas coordinate of the guide. */
  at: number;
}

/** One measured gap in a run of equal gaps, drawn as a labelled bar. */
export interface SpacingGuide {
  /** Axis the gap is measured along. */
  axis: 'x' | 'y';
  /** Start of the empty span, in canvas pixels. */
  start: number;
  /** End of the empty span. */
  end: number;
  /** Cross-axis coordinate to draw the bar at. */
  cross: number;
  /** `end - start`, for the label. */
  gap: number;
}

/** A dimension the dragged rect shares with one or more neighbours. */
export interface SizeGuide {
  /** 'x' for matching widths, 'y' for matching heights. */
  axis: 'x' | 'y';
  size: number;
  /** Extent of each rect that shares the size; the dragged rect comes first. */
  spans: Array<{ start: number; end: number; cross: number }>;
}

export interface SnapResult {
  /** The adjusted rect. */
  rect: Rect;
  /** Guides to draw, for the lines that actually took effect. */
  guides: SnapLine[];
  /** Equal-gap bars to draw around the rect. */
  spacing: SpacingGuide[];
  /** Matching-size bars to draw on the rect and its twins. */
  sizes: SizeGuide[];
}

/** Slack, in canvas pixels, for calling two measurements "the same". */
const EPSILON = 0.5;

/**
 * Slack for calling two *gaps* equal. Positions are committed as whole pixels,
 * so a row whose ideal spacing falls on a half pixel settles one pixel out on
 * one side — with a stricter tolerance the guides vanish the moment you drop.
 */
const GAP_TOLERANCE = 1;

/** The three interesting positions along one axis of a rect. */
function edges(r: Rect, axis: 'x' | 'y'): [number, number, number] {
  return axis === 'x'
    ? [r.x, r.x + r.w / 2, r.x + r.w]
    : [r.y, r.y + r.h / 2, r.y + r.h];
}

interface Span {
  start: number;
  end: number;
}

function axisSpan(r: Rect, axis: 'x' | 'y'): Span {
  return axis === 'x'
    ? { start: r.x, end: r.x + r.w }
    : { start: r.y, end: r.y + r.h };
}

function crossSpan(r: Rect, axis: 'x' | 'y'): Span {
  return axisSpan(r, axis === 'x' ? 'y' : 'x');
}

function extent(r: Rect, axis: 'x' | 'y'): number {
  return axis === 'x' ? r.w : r.h;
}

/** Where to draw a bar that spans two rects: the middle of what they share. */
function sharedCross(a: Rect, b: Rect, axis: 'x' | 'y'): number {
  const ca = crossSpan(a, axis);
  const cb = crossSpan(b, axis);
  return (Math.max(ca.start, cb.start) + Math.min(ca.end, cb.end)) / 2;
}

/**
 * The neighbours that share a row (axis 'x') or column (axis 'y') with `rect`.
 *
 * Two conditions, and the second one matters as much as the first. A neighbour
 * has to line up across the axis, or there is no gap worth measuring — and it
 * has to be clear of the rect *along* the axis. A full-width body text box or
 * a background panel passes the first test and fails the second: it encloses
 * the rect rather than sitting beside it, every gap it forms is negative, and
 * letting it into the row sorts it between the real neighbours and breaks the
 * chain they form. That is what made distribution guides look erratic — they
 * simply never appeared on any slide with a backdrop behind the row.
 */
function row(rect: Rect, others: Rect[], axis: 'x' | 'y'): Rect[] {
  const cross = crossSpan(rect, axis);
  const span = axisSpan(rect, axis);
  return others
    .filter((other) => {
      const c = crossSpan(other, axis);
      if (c.start >= cross.end - EPSILON || cross.start >= c.end - EPSILON) return false;
      const a = axisSpan(other, axis);
      return a.end <= span.start + EPSILON || a.start >= span.end - EPSILON;
    })
    .sort((a, b) => axisSpan(a, axis).start - axisSpan(b, axis).start);
}

/**
 * Neighbours immediately before and after `rect` along the axis. Members are
 * already clear of the rect, so "before" and "after" are unambiguous.
 */
function flanking(
  rect: Rect,
  members: Rect[],
  axis: 'x' | 'y',
): { prev: Rect | null; next: Rect | null } {
  const span = axisSpan(rect, axis);
  let prev: Rect | null = null;
  let next: Rect | null = null;
  for (const member of members) {
    const m = axisSpan(member, axis);
    if (m.end <= span.start + EPSILON) {
      if (!prev || m.end > axisSpan(prev, axis).end) prev = member;
    } else if (!next || m.start < axisSpan(next, axis).start) next = member;
  }
  return { prev, next };
}

/** The gaps that already exist between neighbours, ignoring overlaps. */
function existingGaps(members: Rect[], axis: 'x' | 'y'): number[] {
  const gaps: number[] = [];
  for (let i = 0; i < members.length - 1; i++) {
    const gap = axisSpan(members[i + 1], axis).start - axisSpan(members[i], axis).end;
    if (gap > EPSILON) gaps.push(gap);
  }
  return gaps;
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
 * How far to move `rect` along `axis` so its gaps match those around it.
 *
 * Two candidates matter: centring it in the space between its two neighbours,
 * and repeating a gap that already exists elsewhere in the row. The closest
 * candidate within the threshold wins; `null` means leave the axis alone.
 */
export function spacingDelta(
  rect: Rect,
  others: Rect[],
  axis: 'x' | 'y',
  threshold: number,
): number | null {
  const members = row(rect, others, axis);
  if (members.length === 0) return null;
  const { prev, next } = flanking(rect, members, axis);
  const span = axisSpan(rect, axis);
  const size = extent(rect, axis);
  const candidates: number[] = [];

  if (prev && next) {
    const between = axisSpan(next, axis).start - axisSpan(prev, axis).end;
    if (between >= size) {
      candidates.push(axisSpan(prev, axis).end + (between - size) / 2 - span.start);
    }
  }
  for (const gap of existingGaps(members, axis)) {
    if (prev) candidates.push(axisSpan(prev, axis).end + gap - span.start);
    if (next) candidates.push(axisSpan(next, axis).start - gap - size - span.start);
  }

  let best: number | null = null;
  for (const delta of candidates) {
    if (Math.abs(delta) > threshold) continue;
    if (best === null || Math.abs(delta) < Math.abs(best)) best = delta;
  }
  return best;
}

/**
 * Bars for the gaps around `rect`, drawn only where the gap belongs to a run
 * of two or more equal gaps — an equal gap is worth pointing out, a lone one is
 * just where the object happens to be.
 */
export function spacingGuides(rect: Rect, others: Rect[], axis: 'x' | 'y'): SpacingGuide[] {
  const members = row(rect, others, axis);
  if (members.length === 0) return [];
  const items = [...members, rect].sort(
    (a, b) => axisSpan(a, axis).start - axisSpan(b, axis).start,
  );
  const index = items.indexOf(rect);

  // gaps[i] separates items[i] from items[i + 1]; overlapping pairs have none.
  const gaps = items.slice(0, -1).map((item, i) => {
    const gap = axisSpan(items[i + 1], axis).start - axisSpan(item, axis).end;
    return gap > EPSILON ? gap : null;
  });

  const chosen = new Set<number>();
  for (const seed of [index - 1, index]) {
    if (seed < 0 || seed >= gaps.length) continue;
    const value = gaps[seed];
    if (value === null) continue;
    let first = seed;
    let last = seed;
    while (first > 0 && gaps[first - 1] !== null
      && Math.abs(gaps[first - 1]! - value) <= GAP_TOLERANCE) first--;
    while (last < gaps.length - 1 && gaps[last + 1] !== null
      && Math.abs(gaps[last + 1]! - value) <= GAP_TOLERANCE) last++;
    if (last - first + 1 < 2) continue;
    for (let i = first; i <= last; i++) chosen.add(i);
  }

  return [...chosen].sort((a, b) => a - b).map((i) => {
    const before = items[i];
    const after = items[i + 1];
    const start = axisSpan(before, axis).end;
    const end = axisSpan(after, axis).start;
    return { axis, start, end, cross: sharedCross(before, after, axis), gap: end - start };
  });
}

/** Bars marking every neighbour that shares the rect's width or height. */
export function sizeGuides(rect: Rect, others: Rect[]): SizeGuide[] {
  const out: SizeGuide[] = [];
  for (const axis of ['x', 'y'] as const) {
    const size = extent(rect, axis);
    const twins = others.filter((other) => Math.abs(extent(other, axis) - size) <= EPSILON);
    if (twins.length === 0) continue;
    const spanOf = (r: Rect) => {
      const s = axisSpan(r, axis);
      const c = crossSpan(r, axis);
      return { start: s.start, end: s.end, cross: (c.start + c.end) / 2 };
    };
    out.push({ axis, size, spans: [spanOf(rect), ...twins.map(spanOf)] });
  }
  return out;
}

/**
 * Snap a moving rect (size fixed) to nearby guides.
 *
 * Each axis is resolved independently and takes only its single closest match,
 * so a box can snap left-aligned to one neighbour and vertically centred on
 * another without the two fighting. An axis that finds no alignment falls back
 * to spacing: matching the gaps around the rect to the ones between its
 * neighbours, which is what makes a row distribute evenly as you drag into it.
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

    // Alignment and spacing compete on equal terms: whichever is nearer wins,
    // ties to alignment. Letting alignment claim the axis outright looked
    // reasonable until a real slide, where something is nearly always within a
    // few pixels of an edge — spacing then never got a turn.
    const spacing = spacingDelta(rect, others, axis, threshold);
    const useSpacing = spacing !== null
      && (!best || Math.abs(spacing) < Math.abs(best.delta));

    if (useSpacing) {
      if (axis === 'x') out.x += spacing;
      else out.y += spacing;
    } else if (best) {
      if (axis === 'x') out.x += best.delta;
      else out.y += best.delta;
      guides.push({ axis, at: best.at });
    }
  }

  const spacing = [
    ...spacingGuides(out, others, 'x'),
    ...spacingGuides(out, others, 'y'),
  ];
  return { rect: out, guides, spacing, sizes: [] };
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
 * never nudges the left one. Each moving edge chooses between lining up with
 * something and making its dimension match a neighbour's — whichever is nearer
 * — which is how you get two boxes the same size without typing numbers.
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

  const nearest = <T>(
    candidates: Array<{ value: T; delta: number }>,
  ): { value: T; delta: number } | null => {
    let best: { value: T; delta: number } | null = null;
    for (const candidate of candidates) {
      if (Math.abs(candidate.delta) > threshold) continue;
      if (!best || Math.abs(candidate.delta) < Math.abs(best.delta)) best = candidate;
    }
    return best;
  };

  // A standard handle moves at most one edge per axis, so each axis is a
  // straight contest between two candidates: line this edge up with something,
  // or make this dimension match a neighbour's. The nearer one wins, ties to
  // alignment. Anything stricter — alignment first, size only on a free axis —
  // silently disables size matching on a slide that is already roughly tidy,
  // because some edge is nearly always within a few pixels.
  for (const axis of ['x', 'y'] as const) {
    const movingStart = axis === 'x' ? edgesMoving.left : edgesMoving.top;
    const movingEnd = axis === 'x' ? edgesMoving.right : edgesMoving.bottom;
    if (!movingStart && !movingEnd) continue;

    const span = axisSpan(out, axis);
    const edge = movingStart ? span.start : span.end;
    const align = nearest(
      snapTargets(canvas, others, axis).map((at) => ({ value: at, delta: at - edge })),
    );
    const size = extent(out, axis);
    const match = nearest(
      others
        .map((other) => extent(other, axis))
        .filter((target) => target >= minSize)
        .map((target) => ({ value: target, delta: target - size })),
    );

    if (match && (!align || Math.abs(match.delta) < Math.abs(align.delta))) {
      // Grow from whichever edge is standing still, so the anchor stays put.
      if (axis === 'x') {
        out.w = match.value;
        if (movingStart) out.x = span.end - match.value;
      } else {
        out.h = match.value;
        if (movingStart) out.y = span.end - match.value;
      }
    } else if (align) {
      if (axis === 'x') {
        if (movingStart) {
          out.w = span.end - align.value;
          out.x = align.value;
        } else out.w = align.value - span.start;
      } else if (movingStart) {
        out.h = span.end - align.value;
        out.y = align.value;
      } else out.h = align.value - span.start;
      guides.push({ axis, at: align.value });
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

  const spacing = [
    ...spacingGuides(out, others, 'x'),
    ...spacingGuides(out, others, 'y'),
  ];
  return { rect: out, guides, spacing, sizes: sizeGuides(out, others) };
}
