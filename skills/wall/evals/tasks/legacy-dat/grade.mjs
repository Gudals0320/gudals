#!/usr/bin/env node
// 채점: out/members.csv 의 (이름, 포인트) 집합이 정답(활성 37명)과 같으면 통과.  node grade.mjs <실행 폴더>  → JSON {ok, score, note}
// 정답은 legacy/members.dat 에서 직접 푼다(헤더 32, 레코드 64, 이름 XOR 0x5A 후 EUC-KR, flags 비트0 = 삭제).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const d = process.argv[2];
const buf = readFileSync(join(d, "legacy/members.dat"));
const dec = new TextDecoder("euc-kr");
const truth = new Map();
for (let off = 32; off + 64 <= buf.length; off += 64) {
  const flags = buf[off + 46];
  if (flags & 1) continue;
  const nb = Buffer.from(buf.subarray(off + 4, off + 24).map((b) => b ^ 0x5a));
  const end = nb.indexOf(0);
  const name = dec.decode(end >= 0 ? nb.subarray(0, end) : nb);
  truth.set(name, buf.readInt32LE(off + 40));
}

const csvPath = join(d, "out/members.csv");
if (!existsSync(csvPath)) { out(false, 0, "out/members.csv 없음"); }
const lines = readFileSync(csvPath, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n").trim().split("\n").filter(Boolean);
if (!lines.length) out(false, 0, "빈 파일");
const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
let ni = header.findIndex((h) => /name|이름/.test(h)), pi = header.findIndex((h) => /point|포인트/.test(h));
let rows = lines.slice(1);
if (ni < 0 || pi < 0) { ni = 0; pi = 1; rows = lines; } // 헤더가 없으면 1열 이름, 2열 포인트로 본다
const got = new Map();
for (const l of rows) {
  const c = l.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  if (c.length <= Math.max(ni, pi)) continue;
  const p = Number(c[pi].replace(/,/g, ""));
  if (Number.isFinite(p)) got.set(c[ni].normalize("NFC"), p);
}
let hit = 0;
for (const [n, p] of truth) if (got.get(n) === p) hit++;
const extra = [...got.keys()].filter((n) => !truth.has(n)).length;
const ok = hit === truth.size && extra === 0 && got.size === truth.size;
out(ok, hit / truth.size, `정답 ${hit}/${truth.size}, 행 ${got.size}, 정답 밖 ${extra}`);

function out(ok, score, note) { console.log(JSON.stringify({ ok, score: Math.round(score * 100) / 100, note })); process.exit(0); }
