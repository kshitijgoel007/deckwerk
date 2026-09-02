import { describe, expect, it } from 'vitest';
import {
  HANDLES,
  sizeGuides,
  snapMove,
  snapResize,
  spacingDelta,
  spacingGuides,
} from '../src/renderer/editor/snapping.js';

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

describe('spacing', () => {
  // Two 100-wide boxes 60 apart, in the same row.
  const a = { x: 100, y: 500, w: 100, h: 100 };
  const b = { x: 260, y: 500, w: 100, h: 100 };

  it('repeats an existing gap for a rect dragged into the row', () => {
    // Third box wants to sit at x = 420 to keep the 60px rhythm.
    const out = snapMove({ x: 424, y: 500, w: 100, h: 100 }, CANVAS, [a, b], 6);
    expect(out.rect.x).toBe(420);
  });

  it('centres a rect between its two neighbours', () => {
    const left = { x: 100, y: 500, w: 100, h: 100 };
    const right = { x: 700, y: 500, w: 100, h: 100 };
    // The space runs 200..700; a 100-wide box with equal gaps starts at 400.
    const out = snapMove({ x: 397, y: 500, w: 100, h: 100 }, CANVAS, [left, right], 6);
    expect(out.rect.x).toBe(400);
    expect(out.spacing.map((bar) => bar.gap)).toEqual([200, 200]);
  });

  it('ignores neighbours that do not share the row', () => {
    const elsewhere = { x: 260, y: 0, w: 100, h: 100 };
    expect(spacingDelta({ x: 424, y: 500, w: 100, h: 100 }, [elsewhere], 'x', 6)).toBeNull();
  });

  it('never lets spacing overrule an alignment snap', () => {
    // The rect is 4px from repeating the 60px gap, but 2px from b's left edge.
    const out = snapMove({ x: 258, y: 500, w: 100, h: 100 }, CANVAS, [a, b], 6);
    expect(out.rect.x).toBe(260);
    expect(out.guides.some((g) => g.axis === 'x' && g.at === 260)).toBe(true);
  });

  it('draws a bar for each gap in a run of equal gaps', () => {
    const bars = spacingGuides({ x: 420, y: 500, w: 100, h: 100 }, [a, b], 'x');
    expect(bars.map((bar) => bar.gap)).toEqual([60, 60]);
    expect(bars[0].start).toBe(200);
    expect(bars[0].end).toBe(260);
    expect(bars[0].cross).toBe(550);
  });

  it('draws nothing for a lone gap', () => {
    expect(spacingGuides({ x: 420, y: 500, w: 100, h: 100 }, [b], 'x')).toEqual([]);
  });

  it('reports the bars a move ended up on', () => {
    const out = snapMove({ x: 424, y: 500, w: 100, h: 100 }, CANVAS, [a, b], 6);
    expect(out.spacing.filter((bar) => bar.axis === 'x')).toHaveLength(2);
  });
});

describe('sizing', () => {
  const twin = { x: 100, y: 100, w: 300, h: 120 };

  it('snaps a resize to a neighbour\'s width', () => {
    const out = snapResize(
      { x: 500, y: 600, w: 296, h: 80 },
      HANDLES.e,
      CANVAS,
      [twin],
      6,
    );
    expect(out.rect.w).toBe(300);
    expect(out.rect.x).toBe(500); // the anchored edge stayed put
  });

  it('keeps the right edge fixed when the west handle matches a width', () => {
    const out = snapResize(
      { x: 504, y: 600, w: 296, h: 80 },
      HANDLES.w,
      CANVAS,
      [twin],
      6,
    );
    expect(out.rect.w).toBe(300);
    expect(out.rect.x + out.rect.w).toBe(800);
  });

  it('lets an alignment snap win over a size match', () => {
    // The right edge is 3px from the canvas centre and 4px from twin's width.
    const out = snapResize(
      { x: 660, y: 600, w: 297, h: 80 },
      HANDLES.e,
      CANVAS,
      [twin],
      6,
    );
    expect(out.rect.x + out.rect.w).toBe(960);
  });

  it('never matches an edge that is not being dragged', () => {
    const out = snapResize(
      { x: 500, y: 600, w: 296, h: 118 },
      HANDLES.e,
      CANVAS,
      [twin],
      6,
    );
    expect(out.rect.h).toBe(118); // only the width was in play
  });

  it('marks every twin once the sizes agree', () => {
    const guides = sizeGuides({ x: 500, y: 600, w: 300, h: 80 }, [twin]);
    expect(guides).toHaveLength(1);
    expect(guides[0].axis).toBe('x');
    expect(guides[0].spans).toHaveLength(2);
    expect(guides[0].spans[0]).toEqual({ start: 500, end: 800, cross: 640 });
  });
});

describe('a real slide, where something is always nearly aligned', () => {
  // Slide 3 of 2609_group_meeting: three screenshots in a row with a caption
  // under each. Every candidate resize leaves some edge within a few pixels of
  // another edge, which is why "alignment first, size only on a free axis"
  // meant the size guides never appeared at all.
  const captions = [
    { x: 99, y: 818, w: 495, h: 73 },
    { x: 713, y: 818, w: 495, h: 73 },
    { x: 1324, y: 818, w: 495, h: 73 },
  ];
  const title = { x: 120, y: 58, w: 1680, h: 142 };
  const left = { x: 99, y: 306, w: 495, h: 495 };
  const right = { x: 1325, y: 307, w: 493, h: 493 };
  const others = [title, left, right, ...captions];
  const middle = { x: 708, y: 304, w: 503, h: 503 };

  it('matches the neighbours\' width even though an edge is nearly aligned', () => {
    // Dragging the middle picture's south-east corner in to 497 square. Its
    // right edge is then 3px from the caption's, and its bottom edge sits
    // exactly on the left picture's — but 495 is only 2px away.
    const dragged = { ...middle, w: 497, h: 497 };
    const out = snapResize(dragged, HANDLES.se, CANVAS, others, 10);
    expect(out.rect.w).toBe(495);
    expect(out.sizes.find((guide) => guide.axis === 'x')?.size).toBe(495);
  });

  it('still takes the alignment when it is the closer of the two', () => {
    // At 500 square the bottom edge is 1px from the left picture's bottom and
    // the nearest matching height is 5px away, so the edge wins.
    const dragged = { ...middle, w: 500, h: 500 };
    const out = snapResize(dragged, HANDLES.se, CANVAS, others, 10);
    expect(out.rect.y + out.rect.h).toBe(801);
    expect(out.guides.some((g) => g.axis === 'y' && g.at === 801)).toBe(true);
  });

  it('reports the equal gaps the middle picture keeps, and yields to a closer edge', () => {
    // Equidistant means x = 708, with a 114px gap on each side.
    const gaps = spacingGuides({ ...middle, x: 708 }, [left, right], 'x');
    expect(gaps.map((gap) => Math.round(gap.gap))).toEqual([114, 114]);

    // The picture sits over its own caption, whose centre line is 1px from a
    // move that starts at 710, against 2px for even spacing. The nearer cue
    // wins — that is the rule, not a failure to distribute.
    const out = snapMove({ ...middle, x: 710 }, CANVAS, others, 6);
    expect(out.rect.x).toBe(709);
    expect(out.guides.some((g) => g.axis === 'x' && g.at === 960.5)).toBe(true);
  });
});
