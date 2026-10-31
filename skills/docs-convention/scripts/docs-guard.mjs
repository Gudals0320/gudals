#!/usr/bin/env node
// docs 규약 편집 차단 훅 (Claude Code PreToolUse: Write|Edit|MultiEdit|NotebookEdit|Bash).
// stdin 으로 받은 훅 JSON 을 보고, 규약에 어긋나는 편집이면 종료 코드 2 와 stderr 로 이유를 돌려준다.
// 판정 기준은 docs/README.md 2절(구조)과 3절(역할)이다.

import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

const ROOT_ALLOW = ["README.md", "CLAUDE.md", "AGENTS.md", "LICENSE.md"];
const DOCS_ALLOW = ["README.md", "BRIEF.md", "ARCH.md", "PLAN.md", "testing.md", "decisions.md"];
const DOCS_DIRS = ["log", "experiments", "research"];
const LIVE_FOR_WORKER = ["CLAUDE.md", "AGENTS.md", "docs/PLAN.md", "docs/BRIEF.md", "docs/testing.md", "docs/decisions.md", "docs/README.md"];
const MD = /\.(md|mdx|markdown)$/i;

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
const tool = input.tool_name ?? "";
const ti = input.tool_input ?? {};
const cwd = resolve(input.cwd ?? process.cwd());
const isWorker = /[\\/]\.claude[\\/]worktrees[\\/]/.test(cwd + "/");

if (tool === "Bash") {
  const cmd = String(ti.command ?? "");
  if (/--no-verify\b/.test(cmd) || /\bgit\s+commit\b[^|;&\n]*\s-[a-zA-Z]*n[a-zA-Z]*\b/.test(cmd)) deny("커밋 훅을 건너뛰지 않는다(--no-verify 금지). 검사가 실패했으면 문서를 줄인다.");
  if (/core\.hooksPath/.test(cmd) && !/core\.hooksPath\s+\.githooks\b/.test(cmd)) deny("훅 경로를 바꾸지 않는다.");
  if (/\.git[\\/]hooks[\\/]/.test(cmd)) deny(".git/hooks 를 직접 고치지 않는다. 훅은 .githooks/ 에 있다.");
  process.exit(0);
}

if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) process.exit(0);
const fp = ti.file_path ?? ti.notebook_path;
if (!fp) process.exit(0);
const abs = isAbsolute(fp) ? resolve(fp) : resolve(cwd, fp);
const rel = relative(cwd, abs).split("\\").join("/");
if (!rel || rel.startsWith("..") || isAbsolute(rel)) process.exit(0); // 프로젝트 밖은 관여하지 않는다

if (rel === ".docs-budget.json") deny("예산 파일은 사람이 고친다. 예산을 올리지 말고 문서를 줄인다.");

const parts = rel.split("/");
if (MD.test(rel)) {
  if (parts.length === 1 && !ROOT_ALLOW.includes(rel)) deny(`루트에는 ${ROOT_ALLOW.slice(0, 3).join(", ")} 만 둔다. 작업 메모는 docs/log/<작업>.md 에, 설계는 docs/ARCH.md 에 쓴다.`);
  if (parts[0] === "docs") {
    if (parts.length === 2 && !DOCS_ALLOW.includes(parts[1])) deny(`docs/ 바로 아래에는 ${DOCS_ALLOW.join(", ")} 만 둔다. 작업 메모와 보고는 docs/log/<작업>.md 에 쓴다.`);
    if (parts.length >= 3 && !DOCS_DIRS.includes(parts[1])) deny(`docs/ 아래 폴더는 ${DOCS_DIRS.join(", ")} 뿐이다. 새 폴더를 만들지 않는다.`);
    if (parts.length === 3 && parts[1] === "log" && existsSync(abs)) {
      const first = readFileSync(abs, "utf8").split(/\r?\n/)[0].trim();
      if (first === "상태: 닫힘") deny(`${rel} 는 닫힌 작업 파일이다. 닫힌 기록은 고치지 않는다. 새 작업이면 새 파일을 만든다.`);
    }
  }
}
if (isWorker && LIVE_FOR_WORKER.includes(rel)) deny(`작업자는 ${rel} 을 고치지 않는다. 바뀌어야 할 내용은 자기 작업 파일의 보고 절 "계획과 다른 곳" 에 적는다. ARCH 의 자기 모듈 행만 예외다.`);

process.exit(0);

function deny(reason) {
  process.stderr.write(`[docs 규약] ${reason}\n`);
  process.exit(2);
}
