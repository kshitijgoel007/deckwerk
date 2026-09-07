import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFfmpegPath, getFfprobePath, probeMedia } from '../src/main/ffmpeg.js';
import { needsFastStart, writeFastStart } from '../src/main/mp4FastStart.js';

/**
 * Fast-start relocation is verified against a real tail-indexed file and a
 * real decoder: the promise is "same bytes of media, index in front", and only
 * ffprobe can confirm the moved index still addresses every packet.
 */

const run = promisify(execFile);
const FIXTURE = join(__dirname, '..', 'decks', 'demo-deck', 'assets', 'testclip.mp4');

let root = '';
let tailIndexed = '';

/** Top-level atom types in file order. */
async function atomOrder(path: string): Promise<string[]> {
  const bytes = await readFile(path);
  const order: string[] = [];
  for (let offset = 0; offset + 8 <= bytes.length; ) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
    if (size === 0) size = bytes.length - offset;
    order.push(type);
    offset += size;
  }
  return order;
}

/** SHA-256 of the mdat payload, the media bytes a relocation must not touch. */
async function mdatDigest(path: string): Promise<string> {
  const bytes = await readFile(path);
  for (let offset = 0; offset + 8 <= bytes.length; ) {
    let size = bytes.readUInt32BE(offset);
    let header = 8;
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (size === 1) {
      size = Number(bytes.readBigUInt64BE(offset + 8));
      header = 16;
    }
    if (type === 'mdat') return createHash('sha256').update(bytes.subarray(offset + header, offset + size)).digest('hex');
    offset += size;
  }
  throw new Error('no mdat');
}

async function packetCount(path: string): Promise<number> {
  const { stdout } = await run(getFfprobePath(), [
    '-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path,
  ]);
  return Number(stdout.trim());
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'faststart-'));
  // ffmpeg's mp4 muxer writes the index last unless asked otherwise, which is
  // exactly the layout a camera or the macOS screen recorder produces.
  tailIndexed = join(root, 'tail.mp4');
  await run(getFfmpegPath(), ['-v', 'error', '-y', '-i', FIXTURE, '-c', 'copy', '-movflags', '-faststart', tailIndexed]);
}, 60_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('mp4 fast start', () => {
  it('recognises a tail-indexed file and leaves other files alone', async () => {
    expect(await atomOrder(tailIndexed)).toEqual(expect.arrayContaining(['mdat', 'moov']));
    const order = await atomOrder(tailIndexed);
    expect(order.indexOf('moov')).toBeGreaterThan(order.indexOf('mdat'));
    expect(await needsFastStart(tailIndexed)).toBe(true);
    // Not a container at all: a PNG-ish header must simply read as "no".
    const notMedia = join(root, 'not-media.mp4');
    await run(getFfmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=1', '-frames:v', '1', join(root, 'frame.png')]);
    await run('cp', [join(root, 'frame.png'), notMedia]);
    expect(await needsFastStart(notMedia)).toBe(false);
  });

  it('moves moov in front of mdat without touching the media bytes', async () => {
    const out = join(root, 'fast.mp4');
    await writeFastStart(tailIndexed, out);

    const order = await atomOrder(out);
    expect(order[0]).toBe('ftyp');
    expect(order.indexOf('moov')).toBeLessThan(order.indexOf('mdat'));
    expect(await needsFastStart(out)).toBe(false);

    expect((await stat(out)).size).toBe((await stat(tailIndexed)).size);
    expect(await mdatDigest(out)).toBe(await mdatDigest(tailIndexed));
    // The shifted chunk table still addresses every packet, and the decoder
    // agrees on what the file holds.
    expect(await packetCount(out)).toBe(await packetCount(tailIndexed));
    const before = await probeMedia(tailIndexed);
    const after = await probeMedia(out);
    expect(after).toEqual(before);
  });

  it('refuses a file whose index is already in front, leaving no temp file', async () => {
    const fast = join(root, 'fast.mp4');
    await expect(writeFastStart(fast, join(root, 'again.mp4'))).rejects.toThrow(/already/);
    await expect(stat(join(root, 'again.mp4.faststart-tmp'))).rejects.toThrow();
  });
});
