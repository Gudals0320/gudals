// Research toolbox CLI: `npm run r -- <command> ...`. The inquiry-report skill
// drives a run with these commands; `npm run r -- help` lists them.

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import * as c from "./commands.ts";
import { build, verify } from "./build.ts";
import { createRun, isFetch, openRun, RunError, type Run } from "./store.ts";
import type { Label } from "./judge.ts";

const HELP = `inquiry 리서치 도구 상자 (npm run r -- <명령>)

  new "<질문>"                                         새 실행 폴더를 만들고 현재 실행으로 둔다
  frame --region domestic|foreign|mixed --domain "<분야>" --lang ko [--secondary en] --why "<이유>" [--academic]
  plan --file <plan.json> [--because N3]               분해 기록. 처음은 질문만 보고, 바꿀 때는 --because 필수
  approve "<사용자 답 원문>"                            범위 승인. 이것 전에는 검색·받기를 거부한다
  search <discover|support|refute|trace> <ddg|kdca|korea_kr> --lang ko [--claim C2] "<검색어>"
  family --origins <원출처 수> "<주장 묶음>"
  lead --from S1 [--family F1] --platform web|x|reddit --url <url> "<단서 글 요지>"
  fetch <url> --from <S·L id> --kind official|media|web|sns|paper [--via L1] [--origin R3] [--title "<제목>"]
  grep <R id> "<정규식>"                                보관 원문에서 인용할 줄 찾기
  label <C id> <R id> <supports|refutes|inconclusive|irrelevant> --direct|--indirect --why "<이유>" "<인용>" ["<인용>"...]
  note --step <frame|plan|discover|search|judge|decide> [--refs S1,R2] "<그 시점의 판단>"
  origin <L id> <C id> <R id> <faithful|exaggerated|misrepresented|missing_condition|contested|unrelated> --post "<단서 문장>" --origin "<원문 문장>"
  judge                                                판정 규칙(PRD 8절)을 코드로 적용
  decide --surviving "<살아남은 가장 강한 주장>" [--narrowed C3,C4]
  limit <no_fulltext|blocked|open_question|channel_off> "<한계>"
  report --file <report-input.json>                    {"headline": "...", "sentences": [{"text": "...", "refs": ["C2"]}]}
  build [--title "<페이지 제목>"]                        report.json, report.html 생성과 검사
  open                                                 report.html을 기본 브라우저로 연다
  status | verify
  공통: --run <실행 id> (없으면 마지막으로 new 한 실행)`;

const BOOL_FLAGS = new Set(["academic", "direct", "indirect"]);

export function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string | true> } {
  const [cmd = "help", ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name)) flags[name] = true;
      else flags[name] = rest[++i] ?? "";
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

const list = (v: string | true | undefined) => (typeof v === "string" && v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const str = (v: string | true | undefined) => (typeof v === "string" ? v : "");
const need = (v: string | undefined, what: string) => { if (!v) throw new RunError(`missing ${what}`); return v; };

function status(run: Run): string {
  const events = run.events();
  const p = c.latestPlan(run);
  const lines = [`실행 ${run.id}`, `질문: ${events[0]?.question ?? "-"}`];
  const a = events.filter((e) => e.kind === "approve").pop();
  lines.push(p ? `분해 v${p.version}${a ? `, 승인 v${a.version}` : ", 승인 전"}${p.needs_approval ? " (루트가 바뀌어 재승인 필요)" : ""}` : "분해 없음");
  const judged = new Map<string, { status: string; confidence: string }>(c.latestJudgments(run));
  // after decide, show the combined verdicts (a parent's status comes from its crux children)
  const decided = events.filter((e) => e.kind === "decide").pop();
  for (const [id, f] of Object.entries((decided?.claims ?? {}) as Record<string, { status: string; confidence: string }>)) judged.set(id, f);
  for (const cl of p?.claims ?? []) {
    const ev = events.filter((e) => e.kind === "label" && e.claim === cl.id);
    const n = (l: string) => ev.filter((e) => e.label === l).length;
    const s = events.filter((e) => e.kind === "search" && e.claim === cl.id);
    const j = judged.get(cl.id);
    lines.push(`  ${cl.id}${cl.crux ? "*" : " "} ${cl.parent ? `(↑${cl.parent}) ` : ""}지지 ${n("supports")} 반박 ${n("refutes")} 결론없음 ${n("inconclusive")} | 검색 ${s.length}${s.some((x) => x.side === "refute") ? "" : " (반박 검색 없음)"} | ${j ? `${j.status}/${j.confidence}` : "판정 전"} — ${cl.text.slice(0, 50)}`);
  }
  const count = (k: string) => events.filter((e) => e.kind === k).length;
  lines.push(`검색 ${count("search")} · 출처 ${events.filter(isFetch).length} · 근거 ${count("label")} · 단서 ${count("lead")} · 메모 ${count("note")}`);
  return lines.join("\n");
}

export async function main(argv: string[]): Promise<string> {
  const { cmd, pos, flags } = parseArgs(argv);
  if (cmd === "help") return HELP;
  if (cmd === "new") {
    const run = createRun(need(pos.join(" "), "the question"));
    return `새 실행 ${run.id}\n폴더 ${run.dir}`;
  }
  const run = openRun(str(flags.run) || undefined);
  const show = (e: { seq: number; id?: string }) => `기록 #${e.seq}${e.id ? ` ${e.id}` : ""}`;
  switch (cmd) {
    case "frame":
      return show(c.frame(run, { region: str(flags.region), domain: str(flags.domain), primary: need(str(flags.lang), "--lang"), secondary: list(flags.secondary), why: str(flags.why), academic: flags.academic === true }));
    case "plan": {
      const input = JSON.parse(readFileSync(need(str(flags.file), "--file"), "utf8"));
      if (flags.because) input.because = str(flags.because);
      const e = c.plan(run, input);
      return `${show(e)}: 분해 v${e.version}, 명제 ${e.claims.length}개${e.needs_approval ? "\n루트 명제가 승인 때와 달라졌다. 사용자에게 다시 승인받을 것" : ""}`;
    }
    case "approve":
      return show(c.approve(run, need(pos.join(" "), "the user's answer")));
    case "search": {
      const [side, channel, ...q] = pos;
      const { event, hits } = await c.search(run, { side, channel, lang: need(str(flags.lang), "--lang"), claim: str(flags.claim) || null, query: need(q.join(" "), "the query") });
      return [`${event.id} (${event.side}, ${event.channel}) ${hits.length}건${event.problem ? ` · 문제: ${event.problem}` : ""}`,
        ...hits.map((h, i) => `${i + 1}. ${h.date ? `${h.date} ` : ""}${h.url}\n   ${h.text.replace(/\s+/g, " ").slice(0, 220)}`)].join("\n");
    }
    case "family":
      return show(c.family(run, { text: need(pos.join(" "), "the claim text"), origin_groups: Number(flags.origins ?? 1) }));
    case "lead":
      return show(c.lead(run, { found_by: need(str(flags.from), "--from"), family: str(flags.family) || null, platform: str(flags.platform) || "web", url: need(str(flags.url), "--url"), text: need(pos.join(" "), "the lead text") }));
    case "fetch": {
      const e = await c.fetchSource(run, { url: need(pos[0], "the url"), found_by: need(str(flags.from), "--from"), source_kind: str(flags.kind), via_lead: str(flags.via) || null, origin: str(flags.origin) || null, title: str(flags.title) || null });
      if (e.error) return `${show(e)}: 받지 못함 — ${e.error}`;
      return `${show(e)}: ${e.title} (${e.chars}자)\n${run.archived(e.id).slice(0, 1200)}`;
    }
    case "grep":
      return c.grep(run, need(pos[0], "the source id"), need(pos[1], "the pattern")).map((l) => l.slice(0, 400)).join("\n") || "(일치 없음)";
    case "label": {
      const [claim, source, lab, ...quotes] = pos;
      const directness = flags.indirect ? "indirect" : flags.direct ? "direct" : (() => { throw new RunError("--direct or --indirect"); })();
      return show(c.label(run, { claim, source, label: lab as Label, directness, rationale: str(flags.why), quotes }));
    }
    case "note":
      return show(c.note(run, { step: need(str(flags.step), "--step"), refs: list(flags.refs), text: pos.join(" ") }));
    case "origin": {
      const [leadId, claim, source, fidelity] = pos;
      return show(c.originCheck(run, { lead: leadId, claim, source, fidelity, post: str(flags.post), origin: str(flags.origin) }));
    }
    case "judge":
      return c.judgeAll(run).map(({ claim, judgment: j }) => `${claim}: ${j.status}/${j.confidence} — ${j.reason}`).join("\n") || "근거가 붙은 명제가 없다";
    case "decide": {
      const e = c.decide(run, { surviving: need(str(flags.surviving), "--surviving"), narrowed_by: list(flags.narrowed) });
      return `${show(e)}: 루트 ${e.root} ${e.root_status}/${e.confidence} — ${e.reason}`;
    }
    case "limit":
      return show(c.limit(run, need(pos[0], "the kind"), need(pos.slice(1).join(" "), "the text")));
    case "report":
      return show(c.report(run, JSON.parse(readFileSync(need(str(flags.file), "--file"), "utf8"))));
    case "status":
      return status(run);
    case "open": {
      const file = path.join(run.dir, "report.html");
      if (!existsSync(file)) throw new RunError("no report.html yet: run build first");
      const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
      spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
      return `열었다: ${file}`;
    }
    case "verify": {
      const problems = verify(run);
      return problems.length ? `문제 ${problems.length}건\n${problems.join("\n")}` : "검사 통과";
    }
    case "build": {
      const r = build(run, str(flags.title) || "inquiry 보고서");
      return `${r.paths.join("\n")}\n${r.problems.length ? `검사 문제 ${r.problems.length}건\n${r.problems.join("\n")}` : "검사 통과"}`;
    }
    default:
      throw new RunError(`unknown command "${cmd}" (npm run r -- help)`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (out) => console.log(out),
    (err) => {
      console.error(err instanceof RunError ? `거부: ${err.message}` : err);
      process.exitCode = 1;
    },
  );
}
