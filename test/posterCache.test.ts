import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));

import { extractPosterFrame } from '../src/main/ffmpeg.js';
import { posterFor, setPosterCacheDirForTests } from '../src/main/posterCache.js';

/**
 * Poster frames cut in the main process, against real ffmpeg: a JPEG comes
 * out, the same frame is not cut twice, and a changed clip gets a new one.
 */

const FIXTURE = join(__dirname, '..', 'decks', 'demo-deck', 'assets', 'testclip.mp4');
let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'posters-'));
  setPosterCacheDirForTests(join(root, 'cache'));
});

afterAll(async () => {
  setPosterCacheDirForTests(null);
  if (root) await rm(root, { recursive: true, force: true });
});

describe('poster cache', () => {
  it('cuts one JPEG frame', async () => {
    const out = join(root, 'frame.jpg');
    await extractPosterFrame(FIXTURE, 0.5, out);
    const bytes = await readFile(out);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('serves a cached name, and reuses it for the same clip and time', async () => {
    const first = await posterFor(FIXTURE, 0.03);
    expect(first).toMatch(/^[0-9a-f]{32}\.jpg$/);
    const again = await posterFor(FIXTURE, 0.03);
    expect(again).toBe(first);
    const other = await posterFor(FIXTURE, 1);
    expect(other).not.toBe(first);
    expect((await readdir(join(root, 'cache'))).sort()).toEqual([first, other].sort());
  });

  it('keys on the file identity, so an edited clip gets a fresh frame', async () => {
    const copy = join(root, 'clip.mp4');
    await rm(copy, { force: true });
    await (await import('node:fs/promises')).copyFile(FIXTURE, copy);
    const before = await posterFor(copy, 0.03);
    await utimes(copy, new Date(), new Date(Date.now() + 60_000));
    const after = await posterFor(copy, 0.03);
    expect(after).not.toBe(before);
  });

  it('answers null for a clip that is not there', async () => {
    expect(await posterFor(join(root, 'missing.mp4'), 0)).toBeNull();
  });
});
