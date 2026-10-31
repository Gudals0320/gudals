#!/usr/bin/env node
// docs 규약 검사기.
//   node scripts/check-docs.mjs [저장소 경로]            작업 트리 검사
//   node scripts/check-docs.mjs --staged                  스테이지된 내용 검사 (pre-commit)
//   node scripts/check-docs.mjs --close                   단계 닫기: HEAD 대비 비증가, 닫힌 작업 파일 수정까지
//   node scripts/check-docs.mjs --stop                    Claude Code Stop 훅: 실패하면 {"decision":"block"} 출력
// 종료 코드: 0 통과, 1 규약 위반, 2 실행 불가(경로 없음, 설정 오류).
// 예산은 저장소 루트의 .docs-budget.json 으로 바꿀 수 있으나 기본값의 1.5배까지다.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULTS = {
  budgets: {
    "CLAUDE.md": 4000,
    "AGENTS.md": 4000,
    "docs/PLAN.md": 15000,
    "docs/BRIEF.md": 20000,
    "docs/ARCH.md": 40000,
    "docs/testing.md": 8000,
    "docs/README.md": 12000,
  },
  total: 70000,
  rootAllow: ["README.md", "CLAUDE.md", "AGENTS.md", "LICENSE.md"],
  docsAllow: ["README.md", "BRIEF.md", "ARCH.md", "PLAN.md", "testing.md", "decisions.md"],
  docsDirs: ["log", "experiments", "research"],
  briefRowMax: 500,
  instructionMax: 10000,
  decisionsDelta: 3000,
};
const OVERRIDE_CAP = 1.5;
const MD = /\.(md|mdx|markdown)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".claude", "dist", "build", "out", ".venv", "vendor"]);
const LIVE = ["CLAUDE.md", "AGENTS.md", "docs/PLAN.md", "docs/BRIEF.md", "docs/ARCH.md", "docs/testing.md", "docs/README.md"];
// 닫기 커밋에서 커지면 안 되는 문서와 허용치. 문장 하나를 고쳐 쓰면 몇십 자는 늘 수 있으므로 글자 수를 맞추게 하지 않는다.
// PLAN 은 다음 단계가 더 크면 정당하게 커지므로 예산과 구조로만 묶는다.
const NON_GROWING = { "docs/BRIEF.md": 500, "docs/ARCH.md": 1000 };

// ---- 인자 ----
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const rootArg = argv.find((a) => !a.startsWith("--"));
const STAGED = flags.has("--staged");
const CLOSE = flags.has("--close");
const STOP = flags.has("--stop");
const QUIET = STOP;

if (STOP) {
  // Stop 훅은 stdin 으로 JSON 을 준다. 이미 한 번 막은 뒤(stop_hook_active)면 통과시켜 무한 반복을 막는다.
  try { if (JSON.parse(readFileSync(0, "utf8") || "{}").stop_hook_active) process.exit(0); } catch { /* 입력 없음 */ }
}

const root = resolve(rootArg ?? process.cwd());
if (!existsSync(root) || !statSync(root).isDirectory()) fail2(`경로 없음: ${root}`);

const { config, overrides } = loadConfig(root);
const problems = [];
const warnings = [];

// ---- 파일 목록과 읽기 ----
const files = STAGED ? gitFiles() : walk(root);
const read = STAGED ? (rel) => git(["show", `:${rel}`]) : (rel) => readFs(join(root, rel));
const headRead = (rel) => git(["show", `HEAD:${rel}`]);
const has = (rel) => files.includes(rel);

// ---- 1. 예산 ----
const rows = [];
let total = 0;
for (const [rel, budget] of Object.entries(config.budgets)) {
  if (!has(rel)) continue;
  const chars = count(read(rel));
  if (LIVE.includes(rel)) total += chars;
  const over = chars > budget;
  rows.push({ rel, chars, budget, over, note: overrides[rel] ? `기본 ${fmt(DEFAULTS.budgets[rel])} → 재정의` : "" });
  if (over) problems.push(`${rel}: ${fmt(chars)}자, 예산 ${fmt(budget)}자 (${fmt(chars - budget)}자 초과)`);
}
rows.push({ rel: "살아 있는 문서 합계", chars: total, budget: config.total, over: total > config.total, note: overrides.total ? `기본 ${fmt(DEFAULTS.total)} → 재정의` : "" });
if (total > config.total) problems.push(`살아 있는 문서 합계 ${fmt(total)}자, 예산 ${fmt(config.total)}자. 옮기지 말고 줄인다.`);

// ---- 2. 구조 ----
const otherMd = [];
for (const rel of files) {
  if (!MD.test(rel)) continue;
  const parts = rel.split("/");
  if (parts.length === 1) {
    if (!config.rootAllow.includes(rel)) problems.push(`루트에 허용하지 않은 마크다운: ${rel}. docs/log/<작업>.md 로 옮기거나 지운다.`);
  } else if (parts[0] === "docs") {
    if (parts.length === 2) {
      if (!config.docsAllow.includes(parts[1])) problems.push(`docs/ 바로 아래에 규약에 없는 마크다운: ${rel}. docs/log/<작업>.md 로 옮기거나 지운다.`);
    } else if (!config.docsDirs.includes(parts[1])) {
      problems.push(`docs/ 아래에 허용하지 않은 폴더: docs/${parts[1]}/ (${rel}). 허용 폴더는 ${config.docsDirs.join(", ")} 뿐이다.`);
    }
  } else {
    otherMd.push(rel);
  }
}
if (otherMd.length) warnings.push(`docs/ 밖의 마크다운 ${otherMd.length}개: ${otherMd.slice(0, 5).join(", ")}${otherMd.length > 5 ? " ..." : ""}`);

// ---- 3. PLAN 구조 ----
if (has("docs/PLAN.md")) {
  const text = read("docs/PLAN.md");
  for (const h of h2s(text)) {
    if (!/^(지금: .+|다음: .+|열린 결정)$/.test(h)) problems.push(`docs/PLAN.md 의 2단계 제목 "## ${h}" 는 허용되지 않는다. 지금/다음/열린 결정 세 절만 둔다.`);
  }
  const done = text.match(/끝남|끝났다|\(P\d+[a-z]?\)/g);
  if (done) problems.push(`docs/PLAN.md 에 완료 표시 ${done.length}개 (${[...new Set(done)].slice(0, 4).join(", ")}). 끝난 것은 PLAN에서 지운다.`);
}

// ---- 4. 작업 파일 ----
for (const rel of files) {
  if (!/^docs\/log\/[^/]+$/.test(rel) || !MD.test(rel)) continue;
  const text = read(rel);
  const first = text.split("\n")[0].trim();
  if (!/^상태: (열림|닫힘)$/.test(first)) problems.push(`${rel}: 첫 줄은 "상태: 열림" 또는 "상태: 닫힘" 이어야 한다.`);
  for (const h of h2s(text)) {
    if (!["지시", "작업 기록", "보고"].includes(h)) problems.push(`${rel}: 2단계 제목 "## ${h}" 는 허용되지 않는다. 지시/작업 기록/보고 세 절만 둔다.`);
  }
  const inst = section(text, "지시");
  if (inst !== null && count(inst) > config.instructionMax) problems.push(`${rel}: 지시 절 ${fmt(count(inst))}자, 상한 ${fmt(config.instructionMax)}자. 필요한 시나리오만 넣는다.`);
}

// ---- 5. BRIEF 표 행 ----
if (has("docs/BRIEF.md")) {
  const long = read("docs/BRIEF.md").split("\n").filter((l) => l.startsWith("|") && count(l) > config.briefRowMax);
  if (long.length) problems.push(`docs/BRIEF.md: ${config.briefRowMax}자를 넘는 표 행 ${long.length}개 (예: "${long[0].slice(0, 40)}..."). 행을 다시 쓰고 이전 문장은 decisions.md 로.`);
}

// ---- 6. 단계 닫기 ----
if (CLOSE) {
  if (!git(["rev-parse", "HEAD"])) fail2("--close 는 git 저장소와 HEAD 커밋이 필요하다.");
  for (const [rel, slack] of Object.entries(NON_GROWING)) {
    if (!has(rel)) continue;
    const head = headRead(rel);
    if (head === null) continue;
    const cur = count(read(rel)), prev = count(head);
    if (cur > prev + slack) problems.push(`${rel} 가 HEAD보다 ${fmt(cur - prev)}자 커졌다 (${fmt(prev)} → ${fmt(cur)}, 허용 +${fmt(slack)}). 닫기 커밋에서는 틀린 문장만 고친다. 덧붙였으면 그만큼 줄인다.`);
  }
  if (has("docs/decisions.md")) {
    const head = headRead("docs/decisions.md");
    const delta = count(read("docs/decisions.md")) - (head === null ? 0 : count(head));
    if (delta > config.decisionsDelta) problems.push(`docs/decisions.md 가 ${fmt(delta)}자 늘었다. 커밋당 ${fmt(config.decisionsDelta)}자까지다. 결정과 이유만 적는다.`);
  }
  for (const rel of files) {
    if (!/^docs\/log\/[^/]+$/.test(rel) || !MD.test(rel)) continue;
    const head = headRead(rel);
    if (head === null) continue;
    if (/^상태: 닫힘/.test(head.trimStart()) && norm(head) !== norm(read(rel))) problems.push(`${rel} 는 닫힌 작업 파일인데 HEAD와 다르다. 닫힌 기록은 고치지 않는다.`);
  }
}

// ---- 출력 ----
if (STOP) {
  if (problems.length) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: `docs 규약 위반 ${problems.length}개. 줄인 뒤에 끝낸다.\n- ${problems.join("\n- ")}` }));
  }
  process.exit(0);
}
if (!QUIET) {
  const w = Math.max(...rows.map((r) => r.rel.length), 4);
  console.log(`${"파일".padEnd(w)}  ${"문자 수".padStart(9)}  ${"예산".padStart(9)}  상태`);
  for (const r of rows) console.log(`${r.rel.padEnd(w)}  ${fmt(r.chars).padStart(9)}  ${fmt(r.budget).padStart(9)}  ${r.over ? "초과" : "통과"}${r.note ? "  " + r.note : ""}`);
  console.log();
  for (const wmsg of warnings) console.log(`경고: ${wmsg}`);
  if (problems.length) {
    console.log(`어긴 항목 ${problems.length}개:`);
    for (const p of problems) console.log(`- ${p}`);
  } else {
    console.log(`docs 규약 통과${STAGED ? " (스테이지)" : ""}${CLOSE ? " (닫기 검사 포함)" : ""}.`);
  }
}
process.exit(problems.length ? 1 : 0);

// ---- 보조 ----
function loadConfig(dir) {
  const p = join(dir, ".docs-budget.json");
  const config = { ...DEFAULTS, budgets: { ...DEFAULTS.budgets } };
  const overrides = {};
  if (!existsSync(p)) return { config, overrides };
  let user;
  try { user = JSON.parse(readFileSync(p, "utf8")); } catch (e) { fail2(`.docs-budget.json 을 읽지 못했다: ${e.message}`); }
  for (const [rel, v] of Object.entries(user.budgets ?? {})) {
    const base = DEFAULTS.budgets[rel];
    if (base === undefined) fail2(`.docs-budget.json: 알 수 없는 파일 ${rel}`);
    if (!Number.isFinite(v) || v <= 0) fail2(`.docs-budget.json: ${rel} 의 예산 ${v} 는 양수여야 한다.`);
    if (v > base * OVERRIDE_CAP) fail2(`.docs-budget.json: ${rel} 예산 ${fmt(v)} 는 기본 ${fmt(base)} 의 ${OVERRIDE_CAP}배를 넘는다. 예산을 올리지 말고 문서를 줄인다.`);
    config.budgets[rel] = v; overrides[rel] = true;
  }
  if (user.total !== undefined) {
    if (!Number.isFinite(user.total) || user.total <= 0 || user.total > DEFAULTS.total * OVERRIDE_CAP) fail2(`.docs-budget.json: total ${user.total} 은 양수이고 ${fmt(DEFAULTS.total * OVERRIDE_CAP)} 이하여야 한다.`);
    config.total = user.total; overrides.total = true;
  }
  return { config, overrides };
}
function walk(dir, base = dir, out = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) walk(join(dir, d.name), base, out); }
    else if (d.isFile()) out.push(relative(base, join(dir, d.name)).split("\\").join("/"));
  }
  return out;
}
function gitFiles() {
  const out = git(["ls-files", "-z", "--cached"]);
  if (out === null) fail2("--staged 는 git 저장소가 필요하다.");
  return out.split("\0").filter(Boolean);
}
function git(args) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
}
function readFs(abs) { return readFileSync(abs, "utf8"); }
function norm(s) { return s.replace(/\r\n/g, "\n"); }
function count(s) { return [...norm(s)].length; }
function h2s(text) { return norm(text).split("\n").filter((l) => /^## /.test(l)).map((l) => l.slice(3).trim()); }
function section(text, name) {
  const lines = norm(text).split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n");
}
function fmt(n) { return n.toLocaleString("en-US"); }
function fail2(msg) { console.error(msg); process.exit(2); }
