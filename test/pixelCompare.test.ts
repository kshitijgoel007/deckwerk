import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { comparePixelBuffers } = createRequire(import.meta.url)(
  '../scripts/pixel-compare.cjs',
) as {
  comparePixelBuffers: (
    reference: Buffer,
    actual: Buffer,
    width: number,
    height: number,
    options?: { channelTolerance?: number; radius?: number },
  ) => { differing: number; total: number };
};

function bitmap(width: number, height: number, painted: Array<[number, number]>): Buffer {
  const result = Buffer.alloc(width * height * 4, 255);
  for (const [x, y] of painted) {
    const offset = (y * width + x) * 4;
    result[offset] = 0;
    result[offset + 1] = 0;
    result[offset + 2] = 0;
  }
  return result;
}

describe('PDF pixel comparator', () => {
  it('accepts an edge shift inside the configured rasterizer fringe', () => {
    const reference = bitmap(5, 3, [[1, 1], [2, 1]]);
    const actual = bitmap(5, 3, [[2, 1], [3, 1]]);
    expect(comparePixelBuffers(reference, actual, 5, 3, { channelTolerance: 0 }).differing)
      .toBe(0);
  });

  it('still detects missing content', () => {
    const square = Array.from({ length: 9 }, (_, index) => [index % 3 + 1, Math.floor(index / 3) + 1] as [number, number]);
    const reference = bitmap(5, 5, square);
    const actual = bitmap(5, 5, []);
    expect(comparePixelBuffers(reference, actual, 5, 5, { channelTolerance: 0 }).differing)
      .toBeGreaterThan(0);
  });

  it('still detects movement beyond the antialiasing fringe', () => {
    const reference = bitmap(7, 3, [[1, 1]]);
    const actual = bitmap(7, 3, [[4, 1]]);
    expect(comparePixelBuffers(reference, actual, 7, 3, { channelTolerance: 0 }).differing)
      .toBeGreaterThan(0);
  });
});
