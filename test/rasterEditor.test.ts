import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivedAssetPath } from '../src/main/deckStore.js';
import {
  bitmapPoint,
  paintSegment,
  paintStroke,
  pixelHex,
} from '../src/renderer/raster/painting.js';

function paintContext() {
  return {
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
  };
}

describe('raster paint primitives', () => {
  it('maps fitted display coordinates back to source pixels', () => {
    expect(bitmapPoint(250, 175, {
      left: 50, top: 25, width: 400, height: 300,
    }, 1600, 1200)).toEqual({ x: 800, y: 600 });
  });

  it('interpolates round stamps so fast pointer movement leaves no gaps', () => {
    const ctx = paintContext();
    paintSegment(ctx as never, { x: 0, y: 0 }, { x: 100, y: 0 }, 20, 'round', '#123456');
    expect(ctx.fillStyle).toBe('#123456');
    expect(ctx.arc.mock.calls.length).toBeGreaterThan(20);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it('uses axis-aligned stamps for the square brush and handles a click', () => {
    const ctx = paintContext();
    paintStroke(ctx as never, {
      color: '#abcdef', size: 12, shape: 'square', points: [{ x: 20, y: 30 }],
    });
    expect(ctx.fillRect).toHaveBeenCalledWith(14, 24, 12, 12);
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it('converts sampled RGB bytes to a color input value', () => {
    expect(pixelHex(new Uint8ClampedArray([4, 15, 255, 128]))).toBe('#040fff');
  });

  it('allocates numbered PNG siblings without overwriting earlier paint edits', async () => {
    const deckDir = await mkdtemp(join(tmpdir(), 'deckwerk-raster-'));
    try {
      const first = await derivedAssetPath(deckDir, 'assets/photo.jpg', 'paint', '.png');
      expect(first.relative).toBe('assets/photo.paint1.png');
      await writeFile(first.absolute, 'existing');
      const second = await derivedAssetPath(deckDir, 'assets/photo.jpg', 'paint', '.png');
      expect(second.relative).toBe('assets/photo.paint2.png');
    } finally {
      await rm(deckDir, { recursive: true, force: true });
    }
  });
});
