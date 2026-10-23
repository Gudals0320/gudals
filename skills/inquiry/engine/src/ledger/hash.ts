// Canonical JSON and the per-run hash chain.
// Keys are sorted recursively so the same event always hashes the same,
// no matter how the payload object was built.

import { createHash } from "node:crypto";
import type { LedgerEvent } from "./events.ts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type HashedFields = Omit<LedgerEvent, "seq" | "hash">;

/** The global seq is left out on purpose: a run's chain must not depend on other runs. */
export function eventHash(e: HashedFields): string {
  return sha256(canonicalJson({
    run_id: e.run_id, run_seq: e.run_seq, at: e.at, actor: e.actor, kind: e.kind,
    payload: e.payload, input_hashes: e.input_hashes, prompt_ver: e.prompt_ver, prev_hash: e.prev_hash,
  }));
}
