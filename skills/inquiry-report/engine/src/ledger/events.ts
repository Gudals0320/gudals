// Event vocabulary of the ledger. Every state change is one of these kinds;
// projections are only ever computed from them (handoff principle 2).

export const EVENT_KINDS = [
  "RequestReceived", "RequestClassified", "ProblemsProposed", "HypothesesProposed",
  "PlanProposed", "FeedbackGiven", "PlanRevised", "PlanApproved",
  "KernelStarted", "KernelHeartbeat", "TaskIssued", "ActionTaken",
  "EvidenceCaptured", "ClaimJudged", "PivotMade", "ObjectionRaised",
  "ObjectionClosed", "UserActionRaised", "UserActionResolved", "ReportIssued",
  // M2: one model call (format retries included), and one judge's label on a
  // claim-evidence pair. Judgments are computed from labels by code.
  "ModelCalled", "EvidenceLabeled",
  // M2 v2: social and web leads, their grouping into claim families, and the
  // comparison of a lead's claim with the original source it points to.
  "LeadCaptured", "LeadsClustered", "OriginCompared",
  // Written by the ledger itself when a gate refuses a proposed event.
  "GateRejected",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** Who caused the event. Model calls themselves are ModelCalled events. */
export type Actor = "user" | { role: string; model?: string; vendor?: string };

/** What a caller hands to append(). The ledger fills in the chain fields. */
export type ProposedEvent = {
  run_id: string;
  kind: EventKind;
  actor: Actor;
  payload: Record<string, unknown>;
  input_hashes?: string[];
  prompt_ver?: string | null;
  /** Override the timestamp (tests, imports). Defaults to now. */
  at?: string;
};

export type LedgerEvent = {
  seq: number;
  run_id: string;
  run_seq: number;
  at: string;
  actor: Actor;
  kind: EventKind;
  payload: Record<string, unknown>;
  input_hashes: string[];
  prompt_ver: string | null;
  prev_hash: string;
  hash: string;
};

export const GENESIS = "genesis";

export function isEventKind(k: string): k is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(k);
}
