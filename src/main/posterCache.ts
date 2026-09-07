import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { extractPosterFrame } from './ffmpeg.js';

/**
 * Poster frames for preview surfaces, extracted out of process.
 *
 * The slide rail, the Morph panel and Speaker View each need one picture per
 * video element, never playback. Until Sept 2026 they got it by mounting a
 * real `<video>`, letting Chromium fetch the container header, seeking one
 * frame, drawing it to a canvas and tearing the element down — a full media
 * pipeline built and destroyed for every thumbnail, dozens of times per deck
 * open and again on every eviction from the thumbnail cache. On the X-Reason
 * deck (81 videos, screen recordings indexed at the tail) that churn hit a
 * lock inversion between Chromium's main and media threads and froze the
 * editor for good. The deadlock is Chromium's; the churn was ours.
 *
 * So the frame is now cut by ffmpeg in the main process and served back as a
 * JPEG. The renderer never creates a video pipeline for a preview, and the
 * only `<video>` elements left are the ones that play: the editor canvas and
 * the Player. Frames are cached in the app's user data folder — not the deck,
 * which stays exactly the files the author put there — keyed by the file's
 * identity and the requested time, so an edited clip gets a fresh frame.
 */

/** The `deck://` host that serves cached posters (see assetProtocol.ts). */
export const POSTER_HOST = 'posters';

let cacheDirOverride: string | null = null;

/** Where posters live. Tests point this at a scratch folder. */
export function posterCacheDir(): string {
  return cacheDirOverride ?? join(app.getPath('userData'), 'posters');
}

export function setPosterCacheDirForTests(dir: string | null): void {
  cacheDirOverride = dir;
}

/** Bound ffmpeg fan-out: a deck open asks for many frames at once. */
const MAX_CONCURRENT = 3;
let running = 0;
const queue: Array<() => void> = [];
/** One extraction per key, however many elements want it. */
const inFlight = new Map<string, Promise<string | null>>();

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(() => {
    running += 1;
    resolve();
  }));
}

function release(): void {
  running -= 1;
  queue.shift()?.();
}

/**
 * The cached poster file name for `absolutePath` at `time` seconds, cutting
 * it first if it is not there yet. Null when the frame cannot be produced —
 * the renderer then falls back to its in-browser capture.
 */
export async function posterFor(absolutePath: string, time: number): Promise<string | null> {
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    return null;
  }
  const seconds = Number.isFinite(time) && time >= 0 ? time : 0;
  const key = createHash('sha256')
    .update(`${absolutePath}|${info.size}|${Math.round(info.mtimeMs)}|${seconds.toFixed(3)}`)
    .digest('hex')
    .slice(0, 32);
  const name = `${key}.jpg`;
  const dir = posterCacheDir();
  const output = join(dir, name);
  if (existsSync(output)) return name;

  const pending = inFlight.get(name);
  if (pending) return pending;
  const job = (async () => {
    await acquire();
    try {
      if (existsSync(output)) return name;
      await mkdir(dir, { recursive: true });
      await extractPosterFrame(absolutePath, seconds, output);
      return name;
    } catch (error) {
      console.error(`Could not extract a poster frame from ${absolutePath}:`, error);
      return null;
    } finally {
      release();
      inFlight.delete(name);
    }
  })();
  inFlight.set(name, job);
  return job;
}
