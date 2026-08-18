import type { Writable } from 'node:stream';

/**
 * Minimal ZIP writer (method 0, "store") for deck downloads.
 *
 * Deck folders are mostly already-compressed media (H.264, PNG, JPEG), so
 * deflate would buy little at real CPU cost; storing keeps this dependency-free
 * and streams one file at a time. No ZIP64 — a deck over 4GB is not a thing
 * this endpoint should serve anyway.
 */

export interface ZipFile {
  /** Forward-slash relative path inside the archive. */
  name: string;
  /** Called once, when the file's turn comes; only one file is held in memory. */
  load: () => Promise<Buffer>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fixed timestamp: archives are downloads, not backups; determinism beats mtimes. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

const UTF8_FLAG = 0x0800;

function write(out: Writable, chunk: Buffer): Promise<void> {
  return out.write(chunk)
    ? Promise.resolve()
    : new Promise((resolve) => out.once('drain', resolve));
}

/** Stream `files` into `out` as a ZIP archive. Does not end the stream. */
export async function writeZip(out: Writable, files: ZipFile[]): Promise<void> {
  interface CentralRecord { name: Buffer; crc: number; size: number; offset: number }
  const central: CentralRecord[] = [];
  let offset = 0;

  for (const file of files) {
    const data = await file.load();
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    await write(out, local);
    await write(out, name);
    await write(out, data);

    central.push({ name, crc, size: data.length, offset });
    offset += local.length + name.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const record of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(0, 10); // method: store
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(record.crc, 16);
    header.writeUInt32LE(record.size, 20);
    header.writeUInt32LE(record.size, 24);
    header.writeUInt16LE(record.name.length, 28);
    // extra, comment, disk start, internal attrs, external attrs: all zero.
    header.writeUInt32LE(record.offset, 42);
    await write(out, header);
    await write(out, record.name);
    centralSize += header.length + record.name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8); // entries on this disk
  eocd.writeUInt16LE(central.length, 10); // entries total
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  await write(out, eocd);
}
