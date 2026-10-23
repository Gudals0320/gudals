// Minimal reader for Microsoft Compound File Binary (OLE2), the container of
// HWP 5.0 documents. Reads the FAT (with DIFAT), the directory tree, and
// both regular and mini streams. Returns every stream by its path
// ("FileHeader", "BodyText/Section0"). Written from the [MS-CFB] spec.

export class CfbError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CfbError";
  }
}

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END = 0xfffffffe;
const FREE = 0xffffffff;
const NOSTREAM = 0xffffffff;

export const isCfb = (buf: Buffer) => buf.length >= 512 && buf.subarray(0, 8).equals(SIGNATURE);

type DirEntry = { name: string; type: number; left: number; right: number; child: number; start: number; size: number };

export function readCfb(buf: Buffer): Map<string, Buffer> {
  if (!isCfb(buf)) throw new CfbError("not a compound file");
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSize = 1 << buf.readUInt16LE(0x20);
  const firstDir = buf.readUInt32LE(0x30);
  const cutoff = buf.readUInt32LE(0x38);
  const firstMiniFat = buf.readUInt32LE(0x3c);
  const numMiniFat = buf.readUInt32LE(0x40);
  let difatNext = buf.readUInt32LE(0x44);
  const numDifat = buf.readUInt32LE(0x48);
  const maxSectors = Math.ceil(buf.length / sectorSize) + 1;
  const sector = (n: number) => {
    const off = (n + 1) * sectorSize;
    if (off >= buf.length) throw new CfbError(`sector ${n} out of range`);
    return buf.subarray(off, Math.min(off + sectorSize, buf.length));
  };

  // FAT sector numbers: 109 in the header, the rest in DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4);
    if (s !== FREE && s !== END) fatSectors.push(s);
  }
  for (let i = 0; i < numDifat && difatNext !== END && difatNext !== FREE; i++) {
    const d = sector(difatNext);
    const per = sectorSize / 4 - 1;
    for (let j = 0; j < per; j++) {
      const s = d.readUInt32LE(j * 4);
      if (s !== FREE && s !== END) fatSectors.push(s);
    }
    difatNext = d.readUInt32LE(per * 4);
  }
  const fat: number[] = [];
  for (const s of fatSectors) {
    const d = sector(s);
    for (let j = 0; j + 4 <= d.length; j += 4) fat.push(d.readUInt32LE(j));
  }

  const chain = (start: number, table: number[]) => {
    const out: number[] = [];
    for (let s = start; s !== END && s !== FREE; s = table[s]) {
      if (s >= table.length || out.length > maxSectors) throw new CfbError("broken sector chain");
      out.push(s);
    }
    return out;
  };
  const readChain = (start: number, size?: number) => {
    const b = Buffer.concat(chain(start, fat).map(sector));
    return size === undefined ? b : b.subarray(0, size);
  };

  const dirBuf = readChain(firstDir);
  const entries: DirEntry[] = [];
  for (let o = 0; o + 128 <= dirBuf.length; o += 128) {
    const nameLen = dirBuf.readUInt16LE(o + 64);
    entries.push({
      name: dirBuf.toString("utf16le", o, o + Math.max(0, nameLen - 2)),
      type: dirBuf[o + 66],
      left: dirBuf.readUInt32LE(o + 68),
      right: dirBuf.readUInt32LE(o + 72),
      child: dirBuf.readUInt32LE(o + 76),
      start: dirBuf.readUInt32LE(o + 116),
      size: dirBuf.readUInt32LE(o + 120),
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw new CfbError("no root entry");

  const miniStream = root.size > 0 ? readChain(root.start, root.size) : Buffer.alloc(0);
  const miniFat: number[] = [];
  if (numMiniFat > 0) {
    const mf = readChain(firstMiniFat);
    for (let j = 0; j + 4 <= mf.length; j += 4) miniFat.push(mf.readUInt32LE(j));
  }
  const readMini = (start: number, size: number) =>
    Buffer.concat(chain(start, miniFat).map((s) => miniStream.subarray(s * miniSize, (s + 1) * miniSize))).subarray(0, size);

  const out = new Map<string, Buffer>();
  const seen = new Set<number>();
  const walk = (id: number, prefix: string) => {
    if (id === NOSTREAM || id >= entries.length || seen.has(id)) return;
    seen.add(id);
    const e = entries[id];
    walk(e.left, prefix);
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.type === 2) out.set(path, e.size < cutoff ? readMini(e.start, e.size) : readChain(e.start, e.size));
    else if (e.type === 1) walk(e.child, path);
    walk(e.right, prefix);
  };
  walk(root.child, "");
  return out;
}
