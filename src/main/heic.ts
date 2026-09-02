import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { encodeRgbaToPng } from './ffmpeg.js';

/**
 * HEIC/HEIF decoding for the asset importer.
 *
 * Chromium has no HEIC decoder, so an iPhone photo dropped on a slide has to
 * become a PNG before anything can paint it. The bundled ffmpeg is no help
 * either — 6.x cannot demux HEIF — so decoding goes through libheif compiled
 * to wasm, which needs no native build and behaves the same on macOS and
 * Linux. It only produces pixels; ffmpeg encodes them.
 */

const require = createRequire(import.meta.url);

interface HeifImage {
  get_width(): number;
  get_height(): number;
  /** Fills `target.data` with RGBA and calls back with the target, or null. */
  display(
    target: { width: number; height: number; data: Uint8ClampedArray },
    done: (result: unknown) => void,
  ): void;
}

interface HeifModule {
  HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] };
}

let cached: HeifModule | null = null;

/**
 * The wasm module is ~1.4MB and instantiates on first require, so it loads
 * lazily: a session that never touches a HEIC never pays for it.
 */
function heif(): HeifModule {
  // The `wasm-bundle` entry embeds the wasm in JS, so it needs no unpacked
  // sidecar file and works from inside app.asar.
  cached ??= require('libheif-js/wasm-bundle') as HeifModule;
  return cached;
}

/** Decode the primary image of a HEIC/HEIF file and write it out as PNG. */
export async function convertHeicToPng(source: string, output: string): Promise<void> {
  const label = basename(source);
  // A Live Photo or a burst holds several images; the primary one is first,
  // and it is the one the author dropped.
  const [image] = new (heif().HeifDecoder)().decode(await readFile(source));
  if (!image) throw new Error(`No image found in ${label}`);

  const width = image.get_width();
  const height = image.get_height();
  if (!width || !height) throw new Error(`Could not read the size of ${label}`);

  const target = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  await new Promise<void>((resolvePromise, reject) => {
    image.display(target, (result) =>
      result ? resolvePromise() : reject(new Error(`Could not decode ${label}`)),
    );
  });

  await encodeRgbaToPng(Buffer.from(target.data.buffer), width, height, output);
}
