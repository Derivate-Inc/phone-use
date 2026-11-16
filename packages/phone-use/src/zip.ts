import { readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Stored-only (method 0) zip writer for the trace artifact.
// Fully synchronous, zero deps, no ZIP64 — trace zips are far below the 4 GB /
// 65k-entry limits. JPEG frames are already compressed, JSONL is small, and a
// dependency-free writer keeps the harness closure clean (tools/dep-guard.ts).
// ---------------------------------------------------------------------------

export type ZipEntry = {
  name: string;
  data: Uint8Array | string;
  /** Entry mtime (defaults to Date.now() — no wall-clock determinism needed). */
  mtimeMs?: number | undefined;
};

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD_LEN = 22;

let CRC_TABLE: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(buf: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS date/time (2-second resolution, local time, floor at 1980).
function dosDateTime(mtimeMs: number): { date: number; time: number } {
  const d = new Date(mtimeMs);
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

type Prepared = { nameBytes: Buffer; data: Buffer; crc: number; date: number; time: number };

function prepare(e: ZipEntry): Prepared {
  const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data);
  const nameBytes = Buffer.from(e.name, 'utf8');
  const { date, time } = dosDateTime(e.mtimeMs ?? Date.now());
  return { nameBytes, data, crc: crc32(data), date, time };
}

function localRecord(p: Prepared): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(LOCAL_SIG, 0);
  h.writeUInt16LE(20, 4); // version needed to extract
  h.writeUInt16LE(0x0800, 6); // general-purpose flag: UTF-8 names
  h.writeUInt16LE(0, 8); // method 0 = stored
  h.writeUInt16LE(p.time, 10);
  h.writeUInt16LE(p.date, 12);
  h.writeUInt32LE(p.crc, 14);
  h.writeUInt32LE(p.data.length, 18); // compressed size (= uncompressed, stored)
  h.writeUInt32LE(p.data.length, 22);
  h.writeUInt16LE(p.nameBytes.length, 26);
  h.writeUInt16LE(0, 28); // extra field length
  return Buffer.concat([h, p.nameBytes, p.data]);
}

function centralRecord(p: Prepared, localOffset: number): Buffer {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(CENTRAL_SIG, 0);
  h.writeUInt16LE(20, 4); // version made by
  h.writeUInt16LE(20, 6); // version needed
  h.writeUInt16LE(0x0800, 8); // UTF-8 names
  h.writeUInt16LE(0, 10); // method 0 = stored
  h.writeUInt16LE(p.time, 12);
  h.writeUInt16LE(p.date, 14);
  h.writeUInt32LE(p.crc, 16);
  h.writeUInt32LE(p.data.length, 20);
  h.writeUInt32LE(p.data.length, 24);
  h.writeUInt16LE(p.nameBytes.length, 28);
  h.writeUInt16LE(0, 30); // extra field length
  h.writeUInt16LE(0, 32); // comment length
  h.writeUInt16LE(0, 34); // disk number start
  h.writeUInt16LE(0, 36); // internal attributes
  h.writeUInt32LE(0, 38); // external attributes
  h.writeUInt32LE(localOffset, 42);
  return Buffer.concat([h, p.nameBytes]);
}

function eocdRecord(count: number, cdSize: number, cdOffset: number): Buffer {
  const h = Buffer.alloc(EOCD_LEN);
  h.writeUInt32LE(EOCD_SIG, 0);
  h.writeUInt16LE(0, 4); // this disk
  h.writeUInt16LE(0, 6); // disk with CD
  h.writeUInt16LE(count, 8); // entries on this disk
  h.writeUInt16LE(count, 10); // entries total
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 16);
  h.writeUInt16LE(0, 20); // comment length
  return h;
}

export function zipStore(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const p = prepare(e);
    const local = localRecord(p);
    centrals.push(centralRecord(p, offset));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  return Buffer.concat([...locals, cd, eocdRecord(entries.length, cd.length, offset)]);
}

export function zipWriteSync(path: string, entries: ZipEntry[]): void {
  writeFileSync(path, zipStore(entries));
}

// Append entries to an existing zip: keep the local entries as-is, splice the
// new locals in AFTER the last existing one (so old central-directory records'
// local-header offsets stay valid), then rebuild CD (old records verbatim +
// new records) and the EOCD.
export function zipAppend(path: string, entries: ZipEntry[]): void {
  const buf = readFileSync(path);
  // Locate the EOCD by scanning back for its signature (comment can be up to
  // 65535 bytes; ours never has one, but stay robust).
  let at = -1;
  const floor = Math.max(0, buf.length - EOCD_LEN - 0xffff);
  for (let i = buf.length - EOCD_LEN; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error(`zipAppend: no end-of-central-directory record in ${path}`);
  const oldCount = buf.readUInt16LE(at + 10);
  const cdSize = buf.readUInt32LE(at + 12);
  const cdOffset = buf.readUInt32LE(at + 16);
  const oldLocals = buf.subarray(0, cdOffset);
  const oldCd = buf.subarray(cdOffset, cdOffset + cdSize);

  const newLocals: Buffer[] = [];
  const newCentrals: Buffer[] = [];
  let offset = cdOffset;
  for (const e of entries) {
    const p = prepare(e);
    const local = localRecord(p);
    newCentrals.push(centralRecord(p, offset));
    newLocals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat([oldCd, ...newCentrals]);
  writeFileSync(
    path,
    Buffer.concat([oldLocals, ...newLocals, cd, eocdRecord(oldCount + entries.length, cd.length, offset)]),
  );
}
