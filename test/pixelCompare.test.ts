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
    options?: {
      channelTolerance?: number;
      edgeChannelTolerance?: number;
      radius?: number;
      highToleranceAreas?: Array<{
        x: number; y: number; w: number; h: number; channelTolerance: number;
      }>;
    },
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

  it('allows a larger color-management tolerance only inside tagged media', () => {
    const reference = bitmap(5, 3, []);
    const actual = Buffer.from(reference);
    for (const x of [1, 3]) actual[(1 * 5 + x) * 4] = 210;
    const result = comparePixelBuffers(reference, actual, 5, 3, {
      channelTolerance: 24,
      radius: 0,
      highToleranceAreas: [{ x: 1, y: 1, w: 1, h: 1, channelTolerance: 64 }],
    });
    expect(result.differing).toBe(1);
  });

  it('allows compositor antialiasing differences at edges but not in solid fills', () => {
    const edgeReference = bitmap(5, 3, []);
    const edgeActual = bitmap(5, 3, []);
    for (const [image, value] of [[edgeReference, 100], [edgeActual, 160]] as const) {
      const offset = (1 * 5 + 2) * 4;
      image[offset] = value;
      image[offset + 1] = value;
      image[offset + 2] = value;
    }
    expect(comparePixelBuffers(edgeReference, edgeActual, 5, 3, {
      channelTolerance: 24,
      edgeChannelTolerance: 80,
      radius: 0,
    }).differing).toBe(0);

    const fillReference = Buffer.alloc(5 * 3 * 4, 100);
    const fillActual = Buffer.alloc(5 * 3 * 4, 160);
    expect(comparePixelBuffers(fillReference, fillActual, 5, 3, {
      channelTolerance: 24,
      edgeChannelTolerance: 80,
      radius: 0,
    }).differing).toBe(15);
  });
});
