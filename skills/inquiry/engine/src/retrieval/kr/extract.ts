// Plain text from the documents Korean public bodies attach: PDF (through the
// installed pdftotext), HWPX (ZIP of OWPML XML) and HWP 5.0 (OLE compound
// file of zlib-compressed record streams). HWP is parsed here from the
// public format spec, so no extra tool is installed. Not handled: HWP 3.x
// files, password-protected HWP, and the body of "distribution" (배포용)
// HWP, which is encrypted; for that one the unencrypted preview text
// (PrvText, about the first page) is returned and marked partial.
//
// Downloaded files are untrusted data. They are written only to a fresh temp
// directory for pdftotext, never opened by another program or executed.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { isCfb, readCfb } from "./cfb.ts";
import { decodeEntities, htmlToText } from "./html.ts";
import { readZip } from "./zip.ts";

export type DocFormat = "pdf" | "hwpx" | "hwp" | "hwp3" | "html" | "zip" | "unknown";

export type Extraction = {
  format: DocFormat;
  ok: boolean;
  /** "full", or "partial" when only a preview could be read. */
  coverage: "full" | "partial" | "none";
  text: string;
  chars: number;
  /** Share of Hangul syllables among letters; low values on a Korean document suggest broken fonts. */
  hangul_ratio: number;
  method: string;
  error: string | null;
  ms: number;
};

export function detectFormat(buf: Buffer, name = "", contentType = ""): DocFormat {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf.subarray(0, 17).toString("latin1") === "HWP Document File") return "hwp3";
  if (isCfb(buf)) return "hwp";
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    // HWPX stores "mimetype" first, uncompressed: application/hwp+zip.
    if (buf.subarray(0, 120).toString("latin1").includes("application/hwp+zip") || /\.hwpx$/i.test(name)) return "hwpx";
    return "zip";
  }
  const head = buf.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  if (/html/.test(contentType) || head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  return "unknown";
}

export function textStats(text: string): { chars: number; hangul_ratio: number } {
  const letters = text.match(/[\p{L}]/gu)?.length ?? 0;
  const hangul = text.match(/[가-힣]/g)?.length ?? 0;
  return { chars: text.replace(/\s/g, "").length, hangul_ratio: letters ? Math.round((hangul / letters) * 1000) / 1000 : 0 };
}

const tidy = (s: string) =>
  s.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();

// ---------- HWPX ----------

/** Text of one OWPML section: <hp:t> runs, a line per <hp:p>, tabs and line breaks kept. */
export function owpmlSectionText(xml: string): string {
  let out = "";
  let inT = 0;
  const re = /<(\/?)(?:[a-zA-Z0-9]+:)?(t|p|tab|lineBreak)\b[^>]*?(\/?)>|([^<]+)|<[^>]*>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const [, close, tag, selfClose, text] = m;
    if (text !== undefined) { if (inT) out += decodeEntities(text); continue; }
    if (tag === "t") { if (!selfClose) inT += close ? -1 : 1; continue; }
    if (tag === "p" && close) out += "\n";
    else if (tag === "tab") out += "\t";
    else if (tag === "lineBreak") out += "\n";
  }
  return out;
}

export function extractHwpx(buf: Buffer): string {
  const files = readZip(buf);
  const sections = [...files.keys()]
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/i)![1]) - Number(b.match(/(\d+)\.xml$/i)![1]));
  if (!sections.length) throw new Error("no Contents/sectionN.xml in package");
  return tidy(sections.map((n) => owpmlSectionText(files.get(n)!.toString("utf8")).replace(/\n+$/, "")).join("\n"));
}

// ---------- HWP 5.0 ----------

export class HwpUnsupported extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HwpUnsupported";
  }
}

const HWPTAG_PARA_TEXT = 16 + 51;

/** Controls that take 8 UTF-16 units (the code, 6 units of data, the code again). */
const WIDE_CONTROLS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

/** One PARA_TEXT payload (UTF-16LE with inline controls) as text. */
export function hwpParaText(data: Buffer): string {
  let out = "";
  for (let i = 0; i + 1 < data.length; ) {
    const c = data.readUInt16LE(i);
    if (c >= 32) { out += String.fromCharCode(c); i += 2; continue; }
    if (WIDE_CONTROLS.has(c)) { if (c === 9) out += "\t"; i += 16; continue; }
    if (c === 10) out += "\n";
    else if (c === 24) out += "-";
    else if (c === 30 || c === 31) out += " ";
    i += 2;
  }
  return out;
}

/** Walks the record stream of one section and joins its paragraphs. */
export function hwpSectionText(stream: Buffer): string {
  const lines: string[] = [];
  for (let p = 0; p + 4 <= stream.length; ) {
    const h = stream.readUInt32LE(p);
    p += 4;
    const tag = h & 0x3ff;
    let size = h >>> 20;
    if (size === 0xfff) { size = stream.readUInt32LE(p); p += 4; }
    if (tag === HWPTAG_PARA_TEXT) lines.push(hwpParaText(stream.subarray(p, p + size)));
    p += size;
  }
  return lines.join("\n");
}

export type HwpHeader = { version: string; compressed: boolean; encrypted: boolean; distribution: boolean };

export function hwpHeader(fileHeader: Buffer): HwpHeader {
  if (fileHeader.subarray(0, 17).toString("latin1") !== "HWP Document File") throw new HwpUnsupported("FileHeader signature missing");
  const v = fileHeader.readUInt32LE(32);
  const flags = fileHeader.readUInt32LE(36);
  return {
    version: `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`,
    compressed: (flags & 1) !== 0,
    encrypted: (flags & 2) !== 0,
    distribution: (flags & 4) !== 0,
  };
}

export function extractHwp(buf: Buffer): { text: string; coverage: "full" | "partial"; note: string } {
  const streams = readCfb(buf);
  const fh = streams.get("FileHeader");
  if (!fh) throw new HwpUnsupported("no FileHeader stream");
  const head = hwpHeader(fh);
  if (head.encrypted) throw new HwpUnsupported("password-protected HWP");
  const preview = () => {
    const pv = streams.get("PrvText");
    return pv ? tidy(pv.toString("utf16le").replace(/\0+$/, "")) : "";
  };
  if (head.distribution) {
    const text = preview();
    if (!text) throw new HwpUnsupported("distribution HWP without preview text");
    return { text, coverage: "partial", note: `HWP ${head.version} distribution document: body encrypted, preview text only` };
  }
  const sections = [...streams.keys()]
    .filter((n) => /^BodyText\/Section\d+$/.test(n))
    .sort((a, b) => Number(a.match(/\d+$/)![0]) - Number(b.match(/\d+$/)![0]));
  if (!sections.length) throw new HwpUnsupported("no BodyText sections");
  const parts = sections.map((n) => {
    const raw = streams.get(n)!;
    return hwpSectionText(head.compressed ? inflateRawSync(raw, { maxOutputLength: 128 * 1024 * 1024 }) : raw);
  });
  return { text: tidy(parts.join("\n")), coverage: "full", note: `HWP ${head.version}${head.compressed ? " compressed" : ""}` };
}

// ---------- PDF ----------

export type PdfOptions = { pdftotext?: string; layout?: boolean; timeoutMs?: number };

/** xpdf's pdftotext on this PC comes with Git for Windows and is not on the Windows PATH. */
const PDFTOTEXT_CANDIDATES = ["pdftotext", "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe"];

/** First pdftotext that runs: $PDFTOTEXT, then PATH, then Git's copy. Null when none. */
export function findPdftotext(env: Record<string, string | undefined> = process.env): string | null {
  for (const c of [env.PDFTOTEXT, ...PDFTOTEXT_CANDIDATES]) {
    if (!c || (c.includes("\\") && !existsSync(c))) continue;
    try {
      execFileSync(c, ["-v"], { stdio: "ignore", timeout: 10_000 });
      return c;
    } catch (e) {
      // xpdf exits 99 after printing its version; only a missing binary is fatal.
      if (typeof (e as { status?: unknown }).status === "number") return c;
    }
  }
  return null;
}

let pdftotextPath: string | null | undefined;

export function extractPdf(buf: Buffer, opts: PdfOptions = {}): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "inquiry-pdf-"));
  const file = path.join(dir, "in.pdf");
  writeFileSync(file, buf);
  const args = ["-enc", "UTF-8", ...(opts.layout ? ["-layout"] : []), file, "-"];
  return new Promise<string>((resolve, reject) => {
    if (!opts.pdftotext && pdftotextPath === undefined) pdftotextPath = findPdftotext();
    const bin = opts.pdftotext ?? pdftotextPath;
    if (!bin) { rmSync(dir, { recursive: true, force: true }); reject(new Error("pdftotext not found")); return; }
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 60_000, encoding: "buffer" }, (err, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) reject(new Error(`pdftotext failed: ${err.message} ${stderr.toString("utf8").slice(0, 300)}`));
      else resolve(tidy(stdout.toString("utf8").replace(/\f/g, "\n")));
    });
  });
}

// ---------- dispatch ----------

export async function extractText(buf: Buffer, opts: { name?: string; contentType?: string; pdf?: PdfOptions } = {}): Promise<Extraction> {
  const t0 = Date.now();
  const format = detectFormat(buf, opts.name, opts.contentType);
  const done = (text: string, method: string, coverage: "full" | "partial" = "full", error: string | null = null): Extraction => {
    const st = textStats(text);
    return { format, ok: error === null && st.chars > 0, coverage: error ? "none" : coverage, text, ...st, method, error, ms: Date.now() - t0 };
  };
  try {
    switch (format) {
      case "pdf": return done(await extractPdf(buf, opts.pdf), "pdftotext");
      case "hwpx": return done(extractHwpx(buf), "owpml-zip");
      case "hwp": {
        const r = extractHwp(buf);
        return done(r.text, `hwp5-records (${r.note})`, r.coverage);
      }
      case "html": return done(htmlToText(buf.toString("utf8")), "html");
      case "hwp3": return done("", "none", "full", "HWP 3.x format is not supported");
      default: return done("", "none", "full", `unsupported format ${format}`);
    }
  } catch (e) {
    return done("", format, "full", (e as Error).message);
  }
}
