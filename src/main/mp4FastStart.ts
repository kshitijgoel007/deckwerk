import { open, rename, unlink } from 'node:fs/promises';

/**
 * Move the `moov` index of an MP4/QuickTime file in front of its media data.
 *
 * A camera or the macOS screen recorder writes the index last, because it is
 * only known when recording stops. Chromium's demuxer then has to seek to the
 * end of the file before it can show a single frame, and inside the editor
 * that means a range request through the deck asset protocol for every
 * `<video>` on every thumbnail — dozens of them at a deck open. Those seeks
 * were in flight in every thread dump of the renderer deadlock that froze the
 * X-Reason deck (Sept 2026), so imports relocate the index up front.
 *
 * This is the classic qt-faststart transform, done here without ffmpeg so the
 * result is byte-identical media: `ftyp` stays first, `moov` follows it, and
 * every chunk offset table (`stco`/`co64`) inside `moov` is shifted by the
 * size of the index that now sits before the data. Nothing is decoded or
 * re-timed, so edit lists and variable frame rates survive untouched — a
 * `-c copy` remux does not guarantee that.
 */

interface Atom {
  type: string;
  offset: number;
  size: number;
  /** Bytes of header (8, or 16 for a 64-bit size). */
  headerSize: number;
}

/** Atoms that contain other atoms, which we descend through to find chunk offset tables. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta']);

async function readAt(handle: Awaited<ReturnType<typeof open>>, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, offset + done);
    if (bytesRead === 0) throw new Error('Unexpected end of file');
    done += bytesRead;
  }
  return buffer;
}

async function topLevelAtoms(handle: Awaited<ReturnType<typeof open>>, fileSize: number): Promise<Atom[]> {
  const atoms: Atom[] = [];
  let offset = 0;
  while (offset + 8 <= fileSize) {
    const header = await readAt(handle, offset, 8);
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) {
      const large = await readAt(handle, offset + 8, 8);
      size = Number(large.readBigUInt64BE(0));
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - offset;
    }
    if (size < headerSize || offset + size > fileSize) throw new Error(`Corrupt atom ${type} at ${offset}`);
    atoms.push({ type, offset, size, headerSize });
    offset += size;
  }
  return atoms;
}

/**
 * True when the file is an MP4/QuickTime container whose `moov` atom comes
 * after its `mdat`. Files that are not ISO-BMFF at all return false.
 */
export async function needsFastStart(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 16) return false;
    const head = await readAt(handle, 0, 8);
    if (head.toString('latin1', 4, 8) !== 'ftyp') return false;
    const atoms = await topLevelAtoms(handle, size);
    const moov = atoms.findIndex((a) => a.type === 'moov');
    const mdat = atoms.findIndex((a) => a.type === 'mdat');
    return moov !== -1 && mdat !== -1 && moov > mdat;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

/** Shift every chunk offset inside a `moov` buffer by `delta` bytes, in place. */
function shiftChunkOffsets(moov: Buffer, delta: number): void {
  const walk = (start: number, end: number): void => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = moov.readUInt32BE(offset);
      const type = moov.toString('latin1', offset + 4, offset + 8);
      let headerSize = 8;
      if (size === 1) {
        size = Number(moov.readBigUInt64BE(offset + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) throw new Error(`Corrupt atom ${type} inside moov`);
      if (type === 'cmov') throw new Error('Compressed moov atoms are not supported');
      if (CONTAINERS.has(type)) {
        walk(offset + headerSize, offset + size);
      } else if (type === 'stco') {
        // version/flags (4) + entry count (4) + 32-bit entries
        const count = moov.readUInt32BE(offset + headerSize + 4);
        let cursor = offset + headerSize + 8;
        for (let i = 0; i < count; i++, cursor += 4) {
          const shifted = moov.readUInt32BE(cursor) + delta;
          if (shifted > 0xffffffff) throw new Error('Chunk offset overflows 32 bits after relocation');
          moov.writeUInt32BE(shifted, cursor);
        }
      } else if (type === 'co64') {
        const count = moov.readUInt32BE(offset + headerSize + 4);
        let cursor = offset + headerSize + 8;
        for (let i = 0; i < count; i++, cursor += 8) {
          moov.writeBigUInt64BE(moov.readBigUInt64BE(cursor) + BigInt(delta), cursor);
        }
      }
      offset += size;
    }
  };
  walk(0, moov.length);
}

/**
 * Write a fast-start copy of `input` to `output`. The output is written to a
 * temporary sibling and renamed into place, so a failure leaves nothing
 * half-written. Callers check `needsFastStart` first; a file whose index is
 * already up front is rejected rather than copied.
 */
export async function writeFastStart(input: string, output: string): Promise<void> {
  const source = await open(input, 'r');
  const temp = `${output}.faststart-tmp`;
  try {
    const { size } = await source.stat();
    const atoms = await topLevelAtoms(source, size);
    const moovIndex = atoms.findIndex((a) => a.type === 'moov');
    const mdatIndex = atoms.findIndex((a) => a.type === 'mdat');
    if (moovIndex === -1 || mdatIndex === -1) throw new Error('Not an MP4/QuickTime file with moov and mdat');
    if (moovIndex < mdatIndex) throw new Error('Index is already in front of the media data');
    const moovAtom = atoms[moovIndex];
    const moov = await readAt(source, moovAtom.offset, moovAtom.size);
    // Only atoms that move (those before moov, except ftyp which stays first)
    // shift by the moov size. The moov itself lands right after ftyp.
    shiftChunkOffsets(moov.subarray(moovAtom.headerSize), moovAtom.size);

    const order: Atom[] = [];
    const ftyp = atoms.find((a) => a.type === 'ftyp');
    if (ftyp) order.push(ftyp);
    order.push(moovAtom);
    for (const atom of atoms) {
      if (atom === ftyp || atom === moovAtom) continue;
      order.push(atom);
    }

    const target = await open(temp, 'w');
    try {
      const chunk = 8 * 1024 * 1024;
      for (const atom of order) {
        if (atom === moovAtom) {
          await target.write(moov, 0, moov.length);
          continue;
        }
        for (let done = 0; done < atom.size; ) {
          const length = Math.min(chunk, atom.size - done);
          const bytes = await readAt(source, atom.offset + done, length);
          await target.write(bytes, 0, length);
          done += length;
        }
      }
    } finally {
      await target.close();
    }
    await rename(temp, output);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  } finally {
    await source.close();
  }
}
