/**
 * Alignment and distribution for a multi-selection. Pure geometry: takes the
 * selected rectangles, returns new positions/sizes keyed by id, so the whole
 * feature is one commit and one undo entry.
 */

export interface AlignRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AlignMode =
  | 'left'
  | 'hcenter'
  | 'right'
  | 'top'
  | 'vcenter'
  | 'bottom'
  | 'distributeH'
  | 'distributeV'
  | 'matchW'
  | 'matchH';

export function alignElements(
  rects: AlignRect[],
  mode: AlignMode,
): Map<string, Partial<AlignRect>> {
  const out = new Map<string, Partial<AlignRect>>();
  if (rects.length < 2) return out;

  const minX = Math.min(...rects.map((r) => r.x));
  const maxRight = Math.max(...rects.map((r) => r.x + r.w));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxBottom = Math.max(...rects.map((r) => r.y + r.h));

  switch (mode) {
    case 'left':
      for (const r of rects) out.set(r.id, { x: minX });
      break;
    case 'right':
      for (const r of rects) out.set(r.id, { x: maxRight - r.w });
      break;
    case 'hcenter': {
      const cx = (minX + maxRight) / 2;
      for (const r of rects) out.set(r.id, { x: cx - r.w / 2 });
      break;
    }
    case 'top':
      for (const r of rects) out.set(r.id, { y: minY });
      break;
    case 'bottom':
      for (const r of rects) out.set(r.id, { y: maxBottom - r.h });
      break;
    case 'vcenter': {
      const cy = (minY + maxBottom) / 2;
      for (const r of rects) out.set(r.id, { y: cy - r.h / 2 });
      break;
    }
    case 'distributeH': {
      // Even gaps between boxes, first and last pinned where they are.
      if (rects.length < 3) break;
      const sorted = [...rects].sort((a, b) => a.x - b.x);
      const totalW = sorted.reduce((s, r) => s + r.w, 0);
      const gap = (maxRight - minX - totalW) / (sorted.length - 1);
      let cursor = minX;
      for (const r of sorted) {
        out.set(r.id, { x: cursor });
        cursor += r.w + gap;
      }
      break;
    }
    case 'distributeV': {
      if (rects.length < 3) break;
      const sorted = [...rects].sort((a, b) => a.y - b.y);
      const totalH = sorted.reduce((s, r) => s + r.h, 0);
      const gap = (maxBottom - minY - totalH) / (sorted.length - 1);
      let cursor = minY;
      for (const r of sorted) {
        out.set(r.id, { y: cursor });
        cursor += r.h + gap;
      }
      break;
    }
    case 'matchW': {
      // The first-selected element is the reference, matching direct-manipulation
      // convention (select the one that is right, then the ones to fix).
      const ref = rects[0];
      for (const r of rects.slice(1)) out.set(r.id, { w: ref.w });
      break;
    }
    case 'matchH': {
      const ref = rects[0];
      for (const r of rects.slice(1)) out.set(r.id, { h: ref.h });
      break;
    }
  }
  return out;
}
