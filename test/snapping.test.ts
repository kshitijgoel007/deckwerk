import { describe, expect, it } from 'vitest';
import { HANDLES, snapMove, snapResize } from '../src/renderer/editor/snapping.js';

const CANVAS = { w: 1920, h: 1080 };

describe('snapMove', () => {
  it('leaves a rect alone when nothing is within the threshold', () => {
    const rect = { x: 500, y: 500, w: 100, h: 100 };
    const out = snapMove(rect, CANVAS, [], 6);
    expect(out.rect).toEqual(rect);
    expect(out.guides).toHaveLength(0);
  });

  it('snaps a near-centred rect onto the canvas centre', () => {
    // Centre of a 100-wide box at canvas centre would be x = 910.
    const out = snapMove({ x: 907, y: 300, w: 100, h: 100 }, CANVAS, [], 6);
    expect(out.rect.x).toBe(910);
    expect(out.guides.some((g) => g.axis === 'x' && g.at === 960)).toBe(true);
  });

  it('snaps the left edge to the canvas edge', () => {
    const out = snapMove({ x: 3, y: 400, w: 200, h: 100 }, CANVAS, [], 6);
    expect(out.rect.x).toBe(0);
  });

  it('aligns to a neighbouring element edge', () => {
    const other = { x: 400, y: 0, w: 100, h: 100 };
    const out = snapMove({ x: 403, y: 500, w: 50, h: 50 }, CANVAS, [other], 6);
    expect(out.rect.x).toBe(400);
  });

  it('resolves the two axes independently', () => {
    const other = { x: 400, y: 700, w: 100, h: 100 };
    const out = snapMove({ x: 402, y: 698, w: 50, h: 50 }, CANVAS, [other], 6);
    expect(out.rect.x).toBe(400);
    expect(out.rect.y).toBe(700);
    expect(out.guides).toHaveLength(2);
  });

  it('never changes the size of a moving rect', () => {
    const out = snapMove({ x: 2, y: 2, w: 123, h: 45 }, CANVAS, [], 6);
    expect(out.rect.w).toBe(123);
    expect(out.rect.h).toBe(45);
  });
});

describe('snapResize', () => {
  it('moves only the edge being dragged', () => {
    // Dragging the east handle: the left edge sits at 3 but must not snap to 0.
    const out = snapResize(
      { x: 3, y: 100, w: 954, h: 200 },
      HANDLES.e,
      CANVAS,
      [],
      6,
    );
    expect(out.rect.x).toBe(3);
    expect(out.rect.w).toBe(957); // right edge snapped to the 960 centre line
  });

  it('adjusts x and w together when dragging a west handle', () => {
    const out = snapResize({ x: 4, y: 0, w: 300, h: 100 }, HANDLES.w, CANVAS, [], 6);
    expect(out.rect.x).toBe(0);
    expect(out.rect.w).toBe(304);
  });

  it('refuses to collapse a box below the minimum size', () => {
    const out = snapResize(
      { x: 100, y: 100, w: 2, h: 2 },
      HANDLES.se,
      CANVAS,
      [],
      6,
      8,
    );
    expect(out.rect.w).toBeGreaterThanOrEqual(8);
    expect(out.rect.h).toBeGreaterThanOrEqual(8);
  });

  it('keeps the anchor edge fixed when a west resize hits the minimum', () => {
    const out = snapResize(
      { x: 500, y: 0, w: 1, h: 100 },
      HANDLES.w,
      CANVAS,
      [],
      0,
      8,
    );
    // Right edge was at 501; it must stay there.
    expect(out.rect.x + out.rect.w).toBe(501);
  });
});
