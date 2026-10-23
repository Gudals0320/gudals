// Turns a run's records into report.json (schema inquiry/report@0, PRD §6.2)
// and report.html (the fixed template with the page title set), and checks
// the run: hash chain, quotes against the archive, note order, numbers in the
// conclusion, a verdict for every claim.

import { readFileSync } from "node:fs";
import path from "node:path";
import { quoteInText } from "../gates/normalize.ts";
import { aggregate, type ClaimNode, type Final } from "./judge.ts";
import { latestJudgments, latestPlan, unbackedNumbers } from "./commands.ts";
import { isFetch, PROJECT_ROOT, sourceKindOf, verifyChain, type Event, type Run } from "./store.ts";

export const TEMPLATE = path.join(PROJECT_ROOT, "report", "template.html");
const ROLES = ["decisive", "supporting", "opposing", "related", "not_counted", "ignored"] as const;

export function verify(run: Run): string[] {
  const events = run.events();
  const problems = verifyChain(events);
  const bySeq = new Map(events.filter((e) => e.id).map((e) => [e.id as string, e.seq]));

  for (const l of events.filter((e) => e.kind === "label")) {
    let text = "";
    try { text = run.archived(l.source); } catch { problems.push(`${l.id}: source ${l.source} has no archived text`); continue; }
    for (const q of l.quotes as string[]) if (!quoteInText(q, text)) problems.push(`${l.id}: quote not in ${l.source}: "${q.slice(0, 50)}"`);
  }
  for (const n of events.filter((e) => e.kind === "note")) {
    for (const r of n.refs ?? []) {
      const s = bySeq.get(r);
      if (s !== undefined && s > n.seq) problems.push(`${n.id} cites ${r}, which was recorded after it`);
    }
  }
  const rep = events.filter((e) => e.kind === "report").pop();
  if (!rep) problems.push("no report yet");
  else for (const s of rep.sentences) {
    const missing = unbackedNumbers(run, s);
    if (missing.length) problems.push(`sentence "${s.text.slice(0, 30)}…": numbers ${missing.join(", ")} not in cited quotes`);
  }
  const p = latestPlan(run);
  if (!p) problems.push("no plan");
  if (!events.some((e) => e.kind === "decide")) problems.push("no decision yet (decide)");
  else if (p) {
    const finals = finalsOf(run);
    for (const c of p.claims) if (!finals.has(c.id)) problems.push(`${c.id} has no verdict`);
  }
  return problems;
}

/** Final verdicts: the decide record's, or computed again for runs recorded before decide kept them. */
function finalsOf(run: Run): Map<string, Final> {
  const d = run.events().filter((e) => e.kind === "decide").pop();
  if (d?.claims) return new Map(Object.entries(d.claims as Record<string, Final>));
  const p = latestPlan(run);
  return p ? aggregate(p.claims as ClaimNode[], latestJudgments(run)) : new Map();
}

export function buildReport(run: Run) {
  const events = run.events();
  const last = (k: string) => events.filter((e) => e.kind === k).pop();
  const request = last("request")!, frame = last("frame"), decide = last("decide"), rep = last("report"), approveE = events.find((e) => e.kind === "approve");
  const p = latestPlan(run)!;
  const plans = events.filter((e) => e.kind === "plan");
  const judges = latestJudgments(run);
  const finals = finalsOf(run);
  const labels = events.filter((e) => e.kind === "label");
  const fetches = events.filter(isFetch);
  const searches = events.filter((e) => e.kind === "search");
  const roleOf = (l: Event): string => {
    const j = judges.get(l.claim) as Record<string, unknown> | undefined;
    return ROLES.find((r) => ((j?.[r] as string[]) ?? []).includes(l.id)) ?? "related";
  };

  const claims = p.claims.map((c) => {
    const f = finals.get(c.id);
    const j = judges.get(c.id);
    return {
      id: c.id, text: c.text, type: c.type, parent: c.parent, crux: !!c.crux, about: null, from_families: [],
      status: f?.status ?? "insufficient", confidence: f?.confidence ?? "low", reason: f?.reason ?? "",
      basis: [`통과 조건: ${c.pass_if}`, `폐기 조건: ${c.kill_if}`], pass_if: c.pass_if, kill_if: c.kill_if,
      decisive: j?.decisive ?? [], opposing: j?.opposing ?? [], evidence: labels.filter((l) => l.claim === c.id).map((l) => l.id),
      added_in: plans.find((x) => x.claims.some((y: { id: string }) => y.id === c.id))?.version ?? null,
    };
  });

  const at = (e?: Event) => e?.at ?? null;
  const minutes = rep && approveE ? Math.round((Date.parse(rep.at) - Date.parse(approveE.at)) / 60000) : null;
  return {
    schema: "inquiry/report@0",
    meta: {
      id: run.id, question: request.question, asked_at: at(request), finished_at: at(rep), duration_min: minutes,
      lang: frame?.lang ?? null, academic_search: !!frame?.academic, sample: false,
      counts: { searches: searches.length, sources: fetches.length, evidence: labels.length, leads: events.filter((e) => e.kind === "lead").length },
    },
    verdict: {
      root: p.root, status: decide?.root_status ?? "insufficient", confidence: decide?.confidence ?? "low",
      headline: rep?.headline ?? "", surviving_claim: decide?.surviving_claim ?? "", sentences: rep?.sentences ?? [],
    },
    claims,
    plans: plans.map((x) => ({ version: x.version, at: x.at, changed: x.changed ?? [], because: x.because ?? null, claims: x.claims.map((c: { id: string }) => c.id), open_conditions: x.open_conditions ?? [], resolved_conditions: x.resolved_conditions ?? [] })),
    families: events.filter((e) => e.kind === "family").map((f) => ({ id: f.id, text: f.text, platforms: [...new Set(events.filter((l) => l.kind === "lead" && l.family === f.id).map((l) => l.platform))], posts: events.filter((l) => l.kind === "lead" && l.family === f.id).length, origin_groups: f.origin_groups })),
    leads: events.filter((e) => e.kind === "lead").map((l) => ({ id: l.id, family: l.family, platform: l.platform, url: l.url, text: l.text, found_by: l.found_by })),
    searches: searches.map((s) => ({ id: s.id, claim: s.claim, side: s.side, channel: s.channel, lang: s.lang, query: s.query, hits: s.hits })),
    sources: fetches.map((f) => ({ id: f.id, title: f.title || f.host, url: f.url, host: f.host, kind: sourceKindOf(f), access: f.access, found_by: f.found_by ? [f.found_by] : [], via_lead: f.via_lead ?? null, origin: f.origin ?? null, error: f.error ?? null })),
    evidence: labels.map((l) => ({
      id: l.id, claim: l.claim, source: l.source, label: l.label, quote: (l.quotes as string[]).join(" … "), quote_ok: l.quote_ok,
      judges: [{ by: "claude", label: l.label }], agreed: true, directness: l.directness, rationale: l.rationale, role: roleOf(l),
    })),
    origin_checks: events.filter((e) => e.kind === "origin_check").map((o) => ({ claim: o.claim, lead: o.lead, family: o.family, source: o.source, fidelity: o.fidelity, post: o.quote_post, origin: o.quote_origin })),
    decisions: events.filter((e) => e.kind === "note").map((n) => ({ at: n.at, step: n.step, text: n.text, refs: n.refs ?? [] })),
    limits: events.filter((e) => e.kind === "limit").map((l) => ({ kind: l.limit_kind, text: l.text })),
  };
}

/**
 * The template page with its title set. With data, the report is embedded so the
 * page is one self-contained file that opens straight from disk; without it, the
 * page reads report.json next to it.
 */
export function reportPage(title: string, template = readFileSync(TEMPLATE, "utf8"), data?: unknown): string {
  const safe = title.replace(/[<>&"]/g, "");
  let page = template.replace(/<title>[^<]*<\/title>/, `<title>${safe}</title>`);
  if (data !== undefined) {
    // "<" is escaped so no string in the data can close the script element
    const json = JSON.stringify(data).replace(/</g, "\\u003c");
    page = page.replace("<script>", () => `<script type="application/json" id="report-data">${json}</script>\n<script>`);
  }
  return page;
}

export function build(run: Run, title: string): { problems: string[]; paths: string[] } {
  const problems = verify(run);
  const data = buildReport(run);
  return {
    problems,
    paths: [run.writeFile("report.json", JSON.stringify(data, null, 2)), run.writeFile("report.html", reportPage(title, undefined, data))],
  };
}
