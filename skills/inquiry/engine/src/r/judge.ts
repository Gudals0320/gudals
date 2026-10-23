// Verdict rules (PRD §8). Claude only labels evidence; these functions decide.
//
// - Grade by source kind: primary record (official, paper followed from an
//   article) 3 > trusted media 2 > general web 1 > SNS 0. A fact needs grade 2+.
// - Direct evidence first; indirect evidence decides only when there is no
//   direct evidence, one confidence step lower.
// - Same origin counts once (a source fetched with --origin points at the
//   source it restates).
// - Both directions in the deciding grade: the side with 2x the other and at
//   least 2 sources wins one step lower; otherwise the claim is contested.
// - Minimum sources: 1, or 2 for direction and magnitude claims unless the
//   deciding grade is a primary record.
// - A claim may not pass without a refute-side search for it.
// - A parent with crux children passes only if they all pass.

export const RULE_VERSION = "prd8-v1";

export type Label = "supports" | "refutes" | "inconclusive" | "irrelevant";
export type Status = "pass" | "fail" | "insufficient" | "contested" | "parked";
export type Confidence = "high" | "medium" | "low" | "very_low";
export type ClaimType = "BOOL" | "DIR" | "MAG" | "EVAL";

export type JudgeEvidence = {
  id: string;
  label: Label;
  directness: "direct" | "indirect";
  sourceKind: string;
  /** Source id of the original this source restates; its own id otherwise. */
  origin: string;
};

export type Judgment = {
  status: Status;
  confidence: Confidence;
  reason: string;
  decisive: string[];
  supporting: string[];
  opposing: string[];
  related: string[];
  not_counted: string[];
  ignored: string[];
  rule_version: string;
};

export const GRADE: Record<string, number> = { official: 3, paper: 3, media: 2, web: 1, sns: 0, blocked: -1 };
const GRADE_NAME: Record<number, string> = { 3: "1차 기록", 2: "신뢰 매체", 1: "일반 웹", 0: "SNS" };
const LEVELS: Confidence[] = ["high", "medium", "low", "very_low"];
const down = (c: Confidence, steps: number): Confidence => LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(c) + steps)];
const gradeOf = (e: JudgeEvidence) => GRADE[e.sourceKind] ?? 1;

export function judgeClaim(type: ClaimType, evidence: JudgeEvidence[], opts: { hasRefuteSearch: boolean }): Judgment {
  const j: Judgment = { status: "insufficient", confidence: "low", reason: "", decisive: [], supporting: [], opposing: [], related: [], not_counted: [], ignored: [], rule_version: RULE_VERSION };

  const usable: JudgeEvidence[] = [];
  for (const e of evidence) {
    if (e.label === "irrelevant" || gradeOf(e) < 0) j.ignored.push(e.id);
    else if (e.label === "inconclusive") j.related.push(e.id);
    else if (gradeOf(e) < 2) j.not_counted.push(e.id);
    else usable.push(e);
  }

  // one vote per origin and direction; the strongest, most direct copy stands
  const rank = (e: JudgeEvidence) => gradeOf(e) * 2 + (e.directness === "direct" ? 1 : 0);
  const kept = new Map<string, JudgeEvidence>();
  for (const e of [...usable].sort((a, b) => rank(b) - rank(a))) {
    const key = `${e.origin}|${e.label}`;
    if (kept.has(key)) j.not_counted.push(e.id);
    else kept.set(key, e);
  }
  const counted = [...kept.values()];

  const direct = counted.filter((e) => e.directness === "direct");
  const pool = direct.length ? direct : counted;
  let steps = direct.length ? 0 : 1;
  if (!pool.length) {
    j.reason = "신뢰 매체 이상의 지지·반박 근거가 없다.";
    return j;
  }

  const top = Math.max(...pool.map(gradeOf));
  const layer = pool.filter((e) => gradeOf(e) === top);
  const sup = layer.filter((e) => e.label === "supports");
  const ref = layer.filter((e) => e.label === "refutes");
  const layerName = GRADE_NAME[top];
  const via = direct.length ? "직접 근거" : "직접 근거가 없어 간접 근거";

  let dir: "supports" | "refutes";
  let majority = "";
  if (sup.length && ref.length) {
    const [hi, lo] = sup.length >= ref.length ? [sup, ref] : [ref, sup];
    if (hi.length >= 2 * lo.length && hi.length >= 2) {
      dir = hi[0].label as "supports" | "refutes";
      steps += 1;
      majority = ` 같은 등급에서 ${hi.length}:${lo.length}로 한쪽이 2배 이상이라 그쪽으로 보되 확신도를 낮춘다.`;
    } else {
      j.status = "contested";
      j.confidence = "low";
      j.decisive = layer.map((e) => e.id);
      j.opposing = [];
      j.supporting = counted.filter((e) => !layer.includes(e)).map((e) => e.id);
      j.reason = `${via} 최고 등급(${layerName})에서 지지 ${sup.length}건과 반박 ${ref.length}건이 맞선다.`;
      return j;
    }
  } else {
    dir = sup.length ? "supports" : "refutes";
  }

  const winners = layer.filter((e) => e.label === dir);
  const need = (type === "DIR" || type === "MAG") && top < 3 ? 2 : 1;
  j.decisive = winners.map((e) => e.id);
  j.opposing = counted.filter((e) => e.label !== dir).map((e) => e.id);
  j.supporting = counted.filter((e) => e.label === dir && !winners.includes(e)).map((e) => e.id);
  if (winners.length < need) {
    j.reason = `${via} 최고 등급(${layerName})에 ${dir === "supports" ? "지지" : "반박"} ${winners.length}건뿐이라 최소 출처 ${need}건에 못 미친다.`;
    return j;
  }
  if (dir === "supports" && !opts.hasRefuteSearch) {
    j.reason = "지지 근거는 있지만 반박 쪽 검색을 하지 않아 통과시킬 수 없다.";
    return j;
  }

  j.status = dir === "supports" ? "pass" : "fail";
  j.confidence = down(top === 3 ? "high" : "medium", steps);
  j.reason = `${via} 최고 등급은 ${layerName}이고 ${winners.length}건이 ${dir === "supports" ? "지지" : "반박"}한다.${majority}${j.opposing.length ? ` 반대 근거 ${j.opposing.length}건이 있다.` : ""}${steps && !majority ? " 간접 근거라 확신도를 한 단계 낮춘다." : ""}`;
  return j;
}

export type ClaimNode = { id: string; parent: string | null; crux: boolean };
export type Final = { status: Status; confidence: Confidence; reason: string };

/**
 * Final status of every claim: a claim's own judgment, combined with its crux
 * children. A claim with no evidence of its own takes its status from them.
 */
export function aggregate(claims: ClaimNode[], own: Map<string, Judgment>): Map<string, Final> {
  const out = new Map<string, Final>();
  const kidsOf = (id: string) => claims.filter((c) => c.parent === id);
  const visit = (c: ClaimNode): Final => {
    const done = out.get(c.id);
    if (done) return done;
    const crux = kidsOf(c.id).filter((k) => k.crux).map((k) => ({ k, f: visit(k) }));
    kidsOf(c.id).filter((k) => !k.crux).forEach(visit);
    const mine = own.get(c.id);
    let f: Final;
    const failed = crux.find((x) => x.f.status === "fail");
    const open = crux.find((x) => x.f.status !== "pass");
    const minConf = (fs: Final[]) => fs.reduce<Confidence>((m, x) => (LEVELS.indexOf(x.confidence) > LEVELS.indexOf(m) ? x.confidence : m), "high");
    if (mine && mine.status === "fail") f = { status: "fail", confidence: mine.confidence, reason: mine.reason };
    else if (failed) f = { status: "fail", confidence: failed.f.confidence, reason: `핵심 쟁점 ${failed.k.id}가 반박되었다.` };
    else if (open) f = { status: "insufficient", confidence: "low", reason: `핵심 쟁점 ${open.k.id}가 아직 ${open.f.status}이다.` };
    else if (mine) f = crux.length ? { ...mine, confidence: minConf([mine, ...crux.map((x) => x.f)]) } : { status: mine.status, confidence: mine.confidence, reason: mine.reason };
    else if (crux.length) f = { status: "pass", confidence: minConf(crux.map((x) => x.f)), reason: `핵심 쟁점 ${crux.map((x) => x.k.id).join(", ")}가 모두 통과했다.` };
    else f = { status: "insufficient", confidence: "low", reason: "근거도 핵심 하위 명제도 없다." };
    out.set(c.id, f);
    return f;
  };
  claims.forEach(visit);
  return out;
}
