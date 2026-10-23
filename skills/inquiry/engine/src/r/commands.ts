// The research toolbox's commands. Each takes a run folder, checks what the
// rules require, and appends one record. The CLI (cli.ts) and the tests call
// these directly. Rules enforced here rather than left to the skill:
//   - no search before the user approves the scope (principle 6)
//   - a plan whose root claim changed needs approval again
//   - a label quote must be in the archived text (principle 3)
//   - a note may only cite records that already exist (no after-the-fact notes)
//   - every number in a conclusion sentence must be in a quote it cites
//   - verdicts come from judge.ts, never from the model (principle 1)

import { quoteInText } from "../gates/normalize.ts";
import { aggregate, judgeClaim, type ClaimNode, type ClaimType, type Judgment, type Label } from "./judge.ts";
import { CHANNELS, type Channel, retriever, type RetrieveDeps } from "./retrieve.ts";
import { isFetch, RunError, sourceKindOf, type Event, type Run } from "./store.ts";

export type Claim = { id: string; text: string; type: ClaimType; parent: string | null; crux: boolean; pass_if: string; kill_if: string };
export type PlanInput = { root: string; claims: Claim[]; open_conditions?: string[]; resolved_conditions?: { text: string; by: string }[]; changed?: { op: string; claim: string }[]; because?: string };

export const SIDES = ["discover", "support", "refute", "trace"] as const;
export const SOURCE_KINDS = ["official", "media", "web", "sns", "paper"] as const;
export const LABELS: Label[] = ["supports", "refutes", "inconclusive", "irrelevant"];
export const FIDELITY = ["faithful", "exaggerated", "misrepresented", "missing_condition", "contested", "unrelated"];
export const LIMIT_KINDS = ["no_fulltext", "blocked", "open_question", "channel_off"];
const TYPES: ClaimType[] = ["BOOL", "DIR", "MAG", "EVAL"];

const fail = (msg: string): never => { throw new RunError(msg); };
const lastOf = (events: Event[], kind: string) => events.filter((e) => e.kind === kind).pop();

export function latestPlan(run: Run): (Event & PlanInput & { version: number }) | undefined {
  return lastOf(run.events(), "plan") as any;
}

function claimIds(run: Run): Set<string> {
  return new Set((latestPlan(run)?.claims ?? []).map((c) => c.id));
}

// ---------- framing and planning ----------

export function frame(run: Run, o: { region: string; domain: string; primary: string; secondary: string[]; why: string; academic: boolean }): Event {
  if (!["domestic", "foreign", "mixed"].includes(o.region)) fail("region must be domestic, foreign or mixed");
  if (!o.why) fail("say why this language (--why)");
  return run.append("frame", "claude", { region: o.region, domain: o.domain, lang: { primary: o.primary, secondary: o.secondary, why: o.why }, academic: o.academic });
}

export function note(run: Run, o: { step: string; text: string; refs: string[] }): Event {
  if (!o.text.trim()) fail("a note needs text");
  const events = run.events();
  const known = new Set([...events.map((e) => e.id).filter(Boolean), ...claimIds(run)]);
  const missing = o.refs.filter((r) => !known.has(r));
  if (missing.length) fail(`note cites records that do not exist yet: ${missing.join(", ")}`);
  return run.append("note", "claude", { id: run.nextId("N"), step: o.step, text: o.text, refs: o.refs });
}

export function plan(run: Run, p: PlanInput): Event {
  const ids = new Set<string>();
  for (const c of p.claims) {
    if (ids.has(c.id)) fail(`claim ${c.id} appears twice`);
    ids.add(c.id);
    if (!TYPES.includes(c.type)) fail(`${c.id}: type must be one of ${TYPES.join(", ")}`);
    if (!c.text || !c.pass_if || !c.kill_if) fail(`${c.id}: text, pass_if and kill_if are required`);
  }
  for (const c of p.claims) if (c.parent && !ids.has(c.parent)) fail(`${c.id}: parent ${c.parent} is not in the plan`);
  const root = p.claims.find((c) => c.id === p.root);
  if (!root || root.parent) fail(`root ${p.root} must be a claim without a parent`);
  const prev = latestPlan(run);
  if (prev && !p.because) fail("a changed plan needs --because <note id> saying what was seen");
  if (p.because && !run.events().some((e) => e.kind === "note" && e.id === p.because)) fail(`note ${p.because} does not exist`);
  // re-approval is needed only when the root claim itself moves
  const approved = approvedPlan(run);
  const approvedRoot = approved?.claims.find((c) => c.id === approved.root)?.text;
  const needs_approval = !!approved && approvedRoot !== root!.text;
  return run.append("plan", "claude", {
    version: (prev?.version ?? 0) + 1, root: p.root, claims: p.claims.map((c) => ({ ...c, crux: !!c.crux, parent: c.parent ?? null })),
    open_conditions: p.open_conditions ?? [], resolved_conditions: p.resolved_conditions ?? [], changed: p.changed ?? [], because: p.because ?? null, needs_approval,
  });
}

function approvedPlan(run: Run) {
  const events = run.events();
  const a = lastOf(events, "approve");
  return a ? (events.find((e) => e.kind === "plan" && e.version === a.version) as any) : undefined;
}

export function approve(run: Run, answer: string): Event {
  const p = latestPlan(run);
  if (!p) fail("write a plan before asking for approval");
  if (!answer.trim()) fail("record the user's own words");
  return run.append("approve", "user", { version: p!.version, answer });
}

function assertApproved(run: Run): void {
  const events = run.events();
  const a = lastOf(events, "approve");
  if (!a) fail("the scope is not approved yet: no searching before approval");
  const p = latestPlan(run)!;
  const changedAfter = events.some((e) => e.kind === "plan" && e.seq > a!.seq && e.needs_approval);
  if (changedAfter && a!.version < p.version) fail("the root claim changed since approval: ask the user again");
}

// ---------- collecting ----------

export async function search(run: Run, o: { side: string; channel: string; lang: string; claim: string | null; query: string }, deps?: RetrieveDeps) {
  assertApproved(run);
  if (!(SIDES as readonly string[]).includes(o.side)) fail(`side must be one of ${SIDES.join(", ")}`);
  if (!(CHANNELS as readonly string[]).includes(o.channel)) fail(`channel must be one of ${CHANNELS.join(", ")}`);
  if (o.side !== "discover" && !o.claim) fail("support, refute and trace searches belong to a claim (--claim)");
  if (o.claim && !claimIds(run).has(o.claim)) fail(`claim ${o.claim} is not in the plan`);
  const id = run.nextId("S");
  const r = await retriever(deps).search(o.channel as Channel, o.query, `inquiry-${run.id}`);
  run.writeFile(`hits-${id}.json`, JSON.stringify(r.hits, null, 2));
  const e = run.append("search", "claude", { id, claim: o.claim, side: o.side, channel: o.channel, lang: o.lang, query: o.query, hits: r.hits.length, problem: r.problem, hit_urls: r.hits.map((h) => h.url) });
  return { event: e, hits: r.hits };
}

export function family(run: Run, o: { text: string; origin_groups: number }): Event {
  return run.append("family", "claude", { id: run.nextId("F"), text: o.text, origin_groups: o.origin_groups });
}

export function lead(run: Run, o: { found_by: string; family: string | null; platform: string; url: string; text: string }): Event {
  const events = run.events();
  if (!events.some((e) => e.kind === "search" && e.id === o.found_by)) fail(`search ${o.found_by} does not exist`);
  if (o.family && !events.some((e) => e.kind === "family" && e.id === o.family)) fail(`family ${o.family} does not exist`);
  return run.append("lead", "claude", { id: run.nextId("L"), found_by: o.found_by, family: o.family, platform: o.platform, url: o.url, text: o.text, pointers: [] });
}

export async function fetchSource(run: Run, o: { url: string; found_by: string; source_kind: string; via_lead: string | null; origin: string | null; title: string | null }, deps?: RetrieveDeps) {
  assertApproved(run);
  if (!(SOURCE_KINDS as readonly string[]).includes(o.source_kind)) fail(`kind must be one of ${SOURCE_KINDS.join(", ")}`);
  const events = run.events();
  if (!events.some((e) => (e.kind === "search" && e.id === o.found_by) || (e.kind === "lead" && e.id === o.found_by))) fail(`${o.found_by} is not a search or lead of this run`);
  if (o.origin && !run.fetchOf(o.origin)) fail(`origin ${o.origin} is not a fetched source`);
  const id = run.nextId("R");
  const host = new URL(o.url).hostname;
  const base = { id, url: o.url, host, source_kind: o.source_kind, found_by: o.found_by, via_lead: o.via_lead, origin: o.origin };
  try {
    const f = await retriever(deps).fetch(o.url);
    const sha = run.archive(f.text);
    return run.append("fetch", "claude", { ...base, title: o.title || f.title || host, access: "full_text", sha256: sha, chars: f.text.length, note: f.note });
  } catch (err) {
    return run.append("fetch", "claude", { ...base, title: o.title || host, access: "none", sha256: null, error: err instanceof Error ? err.message : String(err) });
  }
}

export function grep(run: Run, sourceId: string, pattern: string): string[] {
  const re = new RegExp(pattern, "i");
  return run.archived(sourceId).split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => re.test(l)).map(([n, l]) => `${n}: ${l}`);
}

// ---------- labels and verdicts ----------

export function label(run: Run, o: { claim: string; source: string; label: Label; directness: "direct" | "indirect"; rationale: string; quotes: string[] }): Event {
  if (!claimIds(run).has(o.claim)) fail(`claim ${o.claim} is not in the plan`);
  if (!LABELS.includes(o.label)) fail(`label must be one of ${LABELS.join(", ")}`);
  if (!o.quotes.length) fail("a label needs at least one quote from the source");
  if (!o.rationale) fail("say why (--why)");
  const text = run.archived(o.source);
  const bad = o.quotes.filter((q) => !quoteInText(q, text));
  if (bad.length) fail(`quote not found in the archived text of ${o.source}: ${bad.map((q) => `"${q.slice(0, 60)}"`).join(", ")}`);
  return run.append("label", "claude", { id: run.nextId("E"), claim: o.claim, source: o.source, label: o.label, directness: o.directness, rationale: o.rationale, quotes: o.quotes, quote_ok: true });
}

/** The evidence of one claim, in the shape judge.ts wants. */
export function evidenceFor(run: Run, claimId: string) {
  const events = run.events();
  const fetches = new Map(events.filter(isFetch).map((f) => [f.id, f]));
  const originOf = (id: string): string => { const f = fetches.get(id); return f?.origin ? originOf(f.origin) : id; };
  return events.filter((e) => e.kind === "label" && e.claim === claimId).map((l) => ({
    id: l.id, label: l.label, directness: l.directness, sourceKind: sourceKindOf(fetches.get(l.source)!), origin: originOf(l.source),
  }));
}

export function hasRefuteSearch(run: Run, claimId: string): boolean {
  return run.events().some((e) => e.kind === "search" && e.side === "refute" && e.claim === claimId);
}

/** Runs the rules on every claim that has evidence and records the verdicts. */
export function judgeAll(run: Run): { claim: string; judgment: Judgment }[] {
  const p = latestPlan(run) ?? fail("no plan");
  const out: { claim: string; judgment: Judgment }[] = [];
  for (const c of p!.claims) {
    const ev = evidenceFor(run, c.id);
    if (!ev.length) continue;
    const judgment = judgeClaim(c.type, ev, { hasRefuteSearch: hasRefuteSearch(run, c.id) });
    run.append("judge", "script", { claim: c.id, ...judgment });
    out.push({ claim: c.id, judgment });
  }
  return out;
}

export function latestJudgments(run: Run): Map<string, Judgment> {
  const m = new Map<string, Judgment>();
  for (const e of run.events()) if (e.kind === "judge") m.set(e.claim, e as unknown as Judgment);
  return m;
}

export function decide(run: Run, o: { surviving: string; narrowed_by: string[] }): Event {
  const p = latestPlan(run) ?? fail("no plan");
  const finals = aggregate(p!.claims as ClaimNode[], latestJudgments(run));
  const root = finals.get(p!.root)!;
  return run.append("decide", "script", {
    root: p!.root, root_status: root.status, confidence: root.confidence, reason: root.reason,
    surviving_claim: o.surviving, narrowed_by: o.narrowed_by, claims: Object.fromEntries(finals),
  });
}

export function originCheck(run: Run, o: { lead: string; claim: string; source: string; fidelity: string; post: string; origin: string }): Event {
  const events = run.events();
  const l = events.find((e) => e.kind === "lead" && e.id === o.lead) ?? fail(`lead ${o.lead} does not exist`);
  if (!FIDELITY.includes(o.fidelity)) fail(`fidelity must be one of ${FIDELITY.join(", ")}`);
  if (!quoteInText(o.origin, run.archived(o.source))) fail(`the origin quote is not in the archived text of ${o.source}`);
  return run.append("origin_check", "claude", { lead: o.lead, family: (l as Event).family ?? null, claim: o.claim, source: o.source, fidelity: o.fidelity, quote_post: o.post, quote_origin: o.origin });
}

export function limit(run: Run, kind: string, text: string): Event {
  if (!LIMIT_KINDS.includes(kind)) fail(`kind must be one of ${LIMIT_KINDS.join(", ")}`);
  return run.append("limit", "claude", { limit_kind: kind, text });
}

// ---------- conclusion ----------

/** Numbers in a sentence, without years and season labels like 2026-27. */
export function numbersIn(text: string): string[] {
  const t = text.replace(/\b(19|20)\d\d\s*[-~–]\s*\d\d\b/g, " ");
  return (t.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, "").replace(/,/g, "")).filter((n) => n && !/^(19|20)\d\d$/.test(n));
}

/** Numbers of a sentence that are not in any quote of the claims it cites. */
export function unbackedNumbers(run: Run, sentence: { text: string; refs: string[] }): string[] {
  const quotes = run.events().filter((e) => e.kind === "label" && sentence.refs.includes(e.claim)).flatMap((e) => e.quotes as string[]).join(" ").replace(/,/g, "");
  return numbersIn(sentence.text).filter((n) => !quotes.includes(n));
}

export function report(run: Run, o: { headline: string; sentences: { text: string; refs: string[] }[] }): Event {
  if (!o.headline || !o.sentences.length) fail("a report needs a headline and sentences");
  const ids = claimIds(run);
  for (const s of o.sentences) {
    const unknown = s.refs.filter((r) => !ids.has(r));
    if (!s.refs.length || unknown.length) fail(`every sentence cites plan claims (bad: ${unknown.join(", ") || "none cited"})`);
    const missing = unbackedNumbers(run, s);
    if (missing.length) fail(`"${s.text.slice(0, 40)}…": numbers ${missing.join(", ")} are not in the quotes of ${s.refs.join(", ")}`);
  }
  return run.append("report", "claude", { headline: o.headline, sentences: o.sentences });
}
