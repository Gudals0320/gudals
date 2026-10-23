// Minimal ZIP reader for HWPX (OWPML) packages: reads the central directory
// and inflates stored or deflated entries with node:zlib. No ZIP64, no
// encryption; those raise an error the caller reports as unsupported.

import { inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ZipError";
  }
}

/** Upper bound on one inflated entry, so a zip bomb from the web cannot exhaust memory. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export function readZip(buf: Buffer): Map<string, Buffer> {
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("no end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new ZipError("ZIP64 not supported");
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError(`bad central directory entry at ${p}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new ZipError(`encrypted entry ${name}`);
    if (usize > MAX_ENTRY_BYTES) throw new ZipError(`entry ${name} too large (${usize} bytes)`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new ZipError(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
    else throw new ZipError(`entry ${name} uses compression method ${method}`);
  }
  return out;
}
