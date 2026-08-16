import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { MediaInfo, TrimRequest } from '@shared/ipc.js';

/**
 * All ffmpeg/ffprobe use goes through here.
 *
 * Binaries are resolved in this order: the bundled per-platform binaries from
 * ffmpeg-static/ffprobe-static, then whatever is on PATH. The bundled path is
 * what makes the app work on a fresh Linux box with nothing installed; the
 * PATH fallback keeps development working if the optional dependency wasn't
 * fetched for this platform.
 */

const require = createRequire(import.meta.url);

let ffmpegPath: string | null | undefined;
let ffprobePath: string | null | undefined;

function resolveBinary(
  pkg: string,
  pick: (mod: unknown) => string | undefined,
  fallback: string,
): string {
  try {
    const mod = require(pkg) as unknown;
    const p = pick(mod);
    // In a packaged app the binary lives under app.asar.unpacked, and the
    // path baked in by the module still points inside the archive.
    const unpacked = p?.replace('app.asar', 'app.asar.unpacked');
    if (unpacked && existsSync(unpacked)) return unpacked;
    if (p && existsSync(p)) return p;
  } catch {
    // Optional dependency missing for this platform; fall through to PATH.
  }
  return fallback;
}

export function getFfmpegPath(): string {
  if (ffmpegPath === undefined) {
    ffmpegPath = resolveBinary(
      'ffmpeg-static',
      (m) => (typeof m === 'string' ? m : (m as { default?: string })?.default),
      'ffmpeg',
    );
  }
  return ffmpegPath as string;
}

export function getFfprobePath(): string {
  if (ffprobePath === undefined) {
    ffprobePath = resolveBinary(
      'ffprobe-static',
      (m) => (m as { path?: string })?.path,
      'ffprobe',
    );
  }
  return ffprobePath as string;
}

/** Codecs Chromium decodes on macOS and Linux alike. */
const WEB_SAFE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);

/** The file's video codec name, or null when it cannot be determined. */
export async function videoCodec(absolutePath: string): Promise<string | null> {
  try {
    const out = await run(getFfprobePath(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', absolutePath,
    ]);
    return out.stdout.trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function isWebSafeCodec(codec: string | null): boolean {
  // Unknown codec: assume playable rather than transcode blindly.
  return codec === null || WEB_SAFE_VIDEO_CODECS.has(codec);
}

/** Transcode to H.264/AAC in place-adjacent file; returns the new path. */
export async function transcodeToH264(input: string, output: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output,
    ]);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`transcode failed: ${stderr}`)),
    );
  });
}

/** Natural dimensions and duration, or nulls if the file can't be probed. */
export async function probeMedia(absolutePath: string): Promise<MediaInfo> {
  try {
    const out = await run(getFfprobePath(), [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      absolutePath,
    ]);
    const parsed = JSON.parse(out.stdout) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];
    const duration = Number(parsed.format?.duration);
    return {
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      duration: Number.isFinite(duration) ? duration : null,
    };
  } catch {
    // A still image, an exotic container, or no ffprobe. The caller falls back
    // to a default box size rather than refusing the drop.
    return { width: null, height: null, duration: null };
  }
}

/** Build the ffmpeg argv for a trim/crop, so the UI can show the exact command. */
export function buildTrimArgs(
  req: TrimRequest,
  input: string,
  output: string,
): string[] {
  const args: string[] = ['-hide_banner', '-y'];

  // -ss before -i seeks by index rather than decoding up to the cut, which is
  // the difference between instant and minutes on a long clip.
  if (req.start > 0) args.push('-ss', req.start.toFixed(3));
  args.push('-i', input);
  if (req.end > req.start) args.push('-t', (req.end - req.start).toFixed(3));

  if (req.crop) {
    const { w, h, x, y } = req.crop;
    // Even dimensions: yuv420p chroma subsampling cannot represent odd sizes,
    // and libx264 fails outright on them.
    const ew = Math.max(2, Math.floor(w / 2) * 2);
    const eh = Math.max(2, Math.floor(h / 2) * 2);
    args.push('-vf', `crop=${ew}:${eh}:${Math.round(x)}:${Math.round(y)}`);
  }

  if (!req.crop && req.copyWhenPossible) {
    // Lossless and instant, but the cut lands on the nearest keyframe before
    // the requested start. The UI says so.
    args.push('-c', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-crf', '18',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
    );
  }

  // Puts the moov atom first so the file starts playing without a full read —
  // it matters when a slide appears and the video must start immediately.
  args.push('-movflags', '+faststart', output);
  return args;
}

/**
 * Run a trim/crop, reporting progress parsed from ffmpeg's `-progress` stream.
 * Writes to `output`; the input is never touched.
 */
export async function runTrim(
  req: TrimRequest,
  input: string,
  output: string,
  onProgress: (fraction: number, message: string) => void,
): Promise<void> {
  const duration = Math.max(0.001, req.end - req.start);
  const args = [...buildTrimArgs(req, input, output)];
  // -progress on stdout gives machine-readable `out_time_us=` lines, far more
  // reliable than scraping the human-readable stderr banner.
  args.splice(2, 0, '-progress', 'pipe:1', '-nostats');

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(getFfmpegPath(), args);
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (!m) continue;
        const seconds = Number(m[1]) / 1_000_000;
        onProgress(Math.min(1, seconds / duration), 'Encoding');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Keep only the tail: ffmpeg is verbose, and the error is always last.
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on('error', (err) =>
      reject(new Error(`Could not run ffmpeg (${getFfmpegPath()}): ${err.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) {
        onProgress(1, 'Done');
        resolvePromise();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.trim()}`));
      }
    });
  });
}

function run(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise({ stdout, stderr })
        : reject(new Error(`${bin} exited ${code}: ${stderr.slice(-2000)}`)),
    );
  });
}
