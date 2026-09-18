import { inflateRawSync } from 'node:zlib';
import type { Writable } from 'node:stream';
import {
  CENTRAL_HEADER_SIZE,
  centralHeader,
  crc32,
  encodeName,
  endOfCentralDirectory,
  EOCD_SIZE,
  LOCAL_HEADER_SIZE,
  localHeader,
  type ZipRecord,
} from '../shared/zip.js';

/**
 * Deck archives on the server: streamed out one file at a time for downloads,
 * and read back in for imports. The format itself lives in `shared/zip.ts`,
 * which the collab client uses to build an archive of a deck folder in the
 * browser; this module is the Node half — streaming, and inflate for archives
 * that reach us from other tools.
 */

export { crc32 };

export interface ZipFile {
  /** Forward-slash relative path inside the archive. */
  name: string;
  /** Called once, when the file's turn comes; only one file is held in memory. */
  load: () => Promise<Buffer>;
}

function write(out: Writable, chunk: Uint8Array): Promise<void> {
  return out.write(chunk)
    ? Promise.resolve()
    : new Promise((resolve) => out.once('drain', resolve));
}

/** Stream `files` into `out` as a ZIP archive. Does not end the stream. */
export async function writeZip(out: Writable, files: ZipFile[]): Promise<void> {
  const records: ZipRecord[] = [];
  let offset = 0;

  for (const file of files) {
    const data = await file.load();
    const name = encodeName(file.name);
    const crc = crc32(data);
    const header = localHeader(name, crc, data.length);

    await write(out, header);
    await write(out, name);
    await write(out, data);

    records.push({ name, crc, size: data.length, offset });
    offset += header.length + name.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const record of records) {
    const header = centralHeader(record);
    await write(out, header);
    await write(out, record.name);
    centralSize += header.length + record.name.length;
  }
  await write(out, endOfCentralDirectory(records.length, centralSize, centralStart));
}

/** One file recovered from an archive. */
export interface ZipEntry {
  /** Forward-slash relative path as it was stored. */
  name: string;
  data: Buffer;
}

/**
 * Minimal ZIP reader, the counterpart of `writeZip`.
 *
 * Reads through the central directory rather than scanning for local headers,
 * so an entry whose local header defers its sizes to a data descriptor still
 * reads correctly. Our own archives are stored (method 0); deflate (method 8)
 * is supported too because an archive that has been round-tripped through
 * Finder, Explorer or `zip` arrives compressed. No ZIP64, matching the writer.
 */
export function readZip(archive: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('damaged zip: bad central header');
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLength);
    cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;

    // Directory entries are recorded as zero-length names ending in '/'.
    if (name.endsWith('/')) continue;

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('damaged zip: bad local header');
    const localName = archive.readUInt16LE(localOffset + 26);
    const localExtra = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + LOCAL_HEADER_SIZE + localName + localExtra;
    const raw = archive.subarray(start, start + compressedSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported zip compression method ${method} for "${name}"`);

    if (data.length !== uncompressedSize) throw new Error(`damaged zip: wrong size for "${name}"`);
    if (crc32(data) !== expectedCrc) throw new Error(`damaged zip: checksum mismatch for "${name}"`);
    entries.push({ name, data });
  }
  return entries;
}

/**
 * The EOCD is the last 22 bytes unless the archive carries a trailing comment,
 * so search backwards over the largest comment a 16-bit length allows.
 */
function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - EOCD_SIZE - 0xffff);
  for (let i = archive.length - EOCD_SIZE; i >= earliest; i--) {
    if (archive.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('not a zip archive');
}
