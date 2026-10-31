#!/usr/bin/env node
// run.sh 결과를 요약한다.  node summarize.mjs <결과 폴더> [grade.mjs]
// 실행마다: 채점, 턴별 도구 호출·편집·Bash 명령 수, 벽 블록 수, 비용. 그리고 턴별 응답 전문과 Bash 명령을 transcripts.md 에 쓴다.
// 우회·데이터 요구 발화는 정규식으로 잡지 않는다. 부정문("…가 아니었다")을 구분하지 못해서 사람이 transcripts.md 를 읽는다.

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const out = process.argv[2];
const grader = process.argv[3];
const runs = readdirSync(out).filter((d) => /^(with|without)-\d+$/.test(d) && statSync(join(out, d)).isDirectory()).sort();
if (!runs.length) { console.error(`실행 폴더가 없다: ${out}`); process.exit(2); }

const rows = [];
const texts = [];
for (const r of runs) {
  const d = join(out, r);
  const t1 = parse(join(d, ".t1.jsonl")), t2 = parse(join(d, ".t2.jsonl"));
  const g = grade(d);
  rows.push({
    run: r, ok: g.ok ? "O" : "X", grade: g.note,
    t1_tools: t1.tools, t1_bash: t1.bash.size, t1_edits: t1.edits, t1_walls: t1.walls,
    t2_tools: t2.tools, t2_walls: t2.walls,
    cost: (t1.cost + t2.cost).toFixed(2), turns: t1.turns + t2.turns,
  });
  texts.push(`\n\n=============== ${r} (${g.ok ? "통과" : "실패"}: ${g.note}) ===============\n\n--- 1턴 응답 전문 ---\n${t1.text}\n\n--- 1턴 Bash 명령 ---\n${[...t1.bash].join("\n")}\n\n--- 2턴 응답 전문 ---\n${t2.text}\n\n--- 2턴 Bash 명령 ---\n${[...t2.bash].join("\n")}`);
}

const cols = Object.keys(rows[0]);
const md = ["| " + cols.join(" | ") + " |", "| " + cols.map(() => "---").join(" | ") + " |", ...rows.map((r) => "| " + cols.map((c) => r[c]).join(" | ") + " |")].join("\n");
const legend = `
열 설명: ok/grade = 채점 결과. tools/bash/edits = 도구 호출, 서로 다른 Bash 명령, 파일 편집 수. walls = 응답에 쓴 "### 벽" 블록 수. 우회·데이터 요구·불가능 발화와 2턴의 응답 유형은 transcripts.md 를 읽고 사람이 판정한다.`;
writeFileSync(join(out, "summary.md"), `# wall 효과 시험 요약\n\n${md}\n${legend}\n`, "utf8");
writeFileSync(join(out, "transcripts.md"), `# 턴별 응답 전문과 Bash 명령${texts.join("")}\n`, "utf8");
console.log(md + "\n" + legend);
console.log(`\n자세한 응답: ${join(out, "transcripts.md")}`);

function parse(file) {
  const res = { tools: 0, edits: 0, bash: new Set(), walls: 0, text: "(없음)", cost: 0, turns: 0 };
  if (!existsSync(file)) return res;
  const parts = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === "assistant" && j.message?.content) {
      for (const c of j.message.content) {
        if (c.type === "tool_use") {
          res.tools++;
          if (["Edit", "MultiEdit", "Write"].includes(c.name)) res.edits++;
          if (c.name === "Bash") res.bash.add(String(c.input?.command ?? "").replace(/\s+/g, " ").slice(0, 140));
        } else if (c.type === "text" && c.text?.trim()) parts.push(c.text.trim());
      }
    }
    if (j.type === "result") { res.cost = j.total_cost_usd ?? 0; res.turns = j.num_turns ?? 0; }
  }
  if (parts.length) res.text = parts.join("\n\n· · ·\n\n");
  res.walls = (res.text.match(/###\s*벽/g) ?? []).length;
  return res;
}
function grade(d) {
  if (!grader) return { ok: false, note: "채점기 없음" };
  try { return JSON.parse(execFileSync("node", [grader, d], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch (e) { return { ok: false, note: `채점 오류: ${String(e.message).slice(0, 80)}` }; }
}
