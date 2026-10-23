// Table layout. The events table is the source of truth and is append-only at
// the database level; projection tables are derived and can be rebuilt by replay.

import type { DatabaseSync } from "node:sqlite";

/** Entity name (plan.md section 6) -> projection table. */
export const ENTITY_TABLES = {
  Request: "requests",
  Problem: "problems",
  Plan: "plans",
  Hypothesis: "hypotheses",
  Claim: "claims",
  Pivot: "pivots",
  Task: "tasks",
  Action: "actions",
  Evidence: "evidence",
  AgentKernel: "agent_kernels",
  Judgment: "judgments",
  Objection: "objections",
  Report: "reports",
  Feedback: "feedback",
  Approval: "approvals",
  UserActionRequest: "user_action_requests",
  ModelCall: "model_calls",
  EvidenceLabel: "evidence_labels",
  Lead: "leads",
  ClaimFamily: "claim_families",
  OriginComparison: "origin_comparisons",
} as const;

export type Entity = keyof typeof ENTITY_TABLES;
export const ENTITIES = Object.keys(ENTITY_TABLES) as Entity[];

const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  run_seq      INTEGER NOT NULL,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  input_hashes TEXT NOT NULL,
  prompt_ver   TEXT,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL,
  UNIQUE (run_id, run_seq)
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only: UPDATE is not allowed'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only: DELETE is not allowed'); END;
`;

// Every projection row is keyed by (run_id, id); the full entity lives in a
// JSON column. Field sets follow the design artifact and can grow without migrations.
function projectionDdl(table: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  run_id TEXT NOT NULL,
  id     TEXT NOT NULL,
  data   TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);`;
}

export function createProjectionTables(db: DatabaseSync): void {
  for (const t of Object.values(ENTITY_TABLES)) db.exec(projectionDdl(t));
}

export function createSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(EVENTS_DDL);
    createProjectionTables(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
