import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TrimRequest } from '../src/shared/ipc.js';
import { buildTrimArgs, probeMedia, runTrim } from '../src/main/ffmpeg.js';

/**
 * The trim path is verified against real ffmpeg output, not mocks: the whole
 * point of this feature is that the file on disk comes out with the duration
 * and dimensions that were asked for.
 */

const FIXTURE = join(__dirname, '..', 'decks', 'demo-deck', 'assets', 'testclip.mp4');

function request(over: Partial<TrimRequest> = {}): TrimRequest {
  return {
    deckDir: '',
    src: 'assets/testclip.mp4',
    start: 0,
    end: 6,
    crop: null,
    copyWhenPossible: false,
    ...over,
  };
}

describe('buildTrimArgs', () => {
  it('seeks before the input so long clips cut instantly', () => {
    const args = buildTrimArgs(request({ start: 2, end: 4 }), 'in.mp4', 'out.mp4');
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-t') + 1]).toBe('2.000');
  });

  it('rounds crop dimensions down to even values for yuv420p', () => {
    const args = buildTrimArgs(
      request({ crop: { x: 11, y: 13, w: 641, h: 361 } }),
      'in.mp4',
      'out.mp4',
    );
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=640:360:11:13');
  });

  it('stream-copies only when there is no crop', () => {
    const copyArgs = buildTrimArgs(
      request({ copyWhenPossible: true }),
      'in.mp4',
      'out.mp4',
    );
    expect(copyArgs).toContain('copy');

    const cropArgs = buildTrimArgs(
      request({ copyWhenPossible: true, crop: { x: 0, y: 0, w: 100, h: 100 } }),
      'in.mp4',
      'out.mp4',
    );
    expect(cropArgs).not.toContain('copy');
    expect(cropArgs).toContain('libx264');
  });

  it('always writes a faststart mp4 so playback can begin immediately', () => {
    const args = buildTrimArgs(request(), 'in.mp4', 'out.mp4');
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
  });
});

describe('runTrim against real ffmpeg', () => {
  it('produces a clip of the requested duration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trim-test-'));
    const out = join(dir, 'out.mp4');
    try {
      const seen: number[] = [];
      await runTrim(request({ start: 1, end: 3 }), FIXTURE, out, (f) => seen.push(f));

      const info = await probeMedia(out);
      expect(info.duration).toBeGreaterThan(1.8);
      expect(info.duration).toBeLessThan(2.2);
      // Progress must actually be reported, or the UI bar would never move.
      expect(seen.at(-1)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('crops to the requested pixel dimensions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trim-test-'));
    const out = join(dir, 'out.mp4');
    try {
      await runTrim(
        request({ start: 0, end: 2, crop: { x: 100, y: 50, w: 640, h: 360 } }),
        FIXTURE,
        out,
        () => {},
      );
      const info = await probeMedia(out);
      expect(info.width).toBe(640);
      expect(info.height).toBe(360);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('reports a readable error instead of hanging on a bad input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trim-test-'));
    try {
      await expect(
        runTrim(request(), join(dir, 'nope.mp4'), join(dir, 'out.mp4'), () => {}),
      ).rejects.toThrow(/ffmpeg exited/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
