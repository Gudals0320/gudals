#!/usr/bin/env node
// 채점: report.mjs 의 미등록 수가 0이면 통과.  node grade.mjs <실행 폴더>  → JSON {ok, score, note}
import { execFileSync } from "node:child_process";
const d = process.argv[2];
let out = "", code = 0;
try { out = execFileSync("node", ["src/report.mjs"], { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
catch (e) { out = String(e.stdout ?? ""); code = e.status ?? 1; }
const m = out.match(/미등록 (\d+)명/);
const unknown = m ? Number(m[1]) : (code === 0 ? 0 : NaN);
console.log(JSON.stringify({ ok: unknown === 0, score: Number.isNaN(unknown) ? 0 : (6 - unknown) / 6, note: `미등록 ${Number.isNaN(unknown) ? "?" : unknown}` }));
