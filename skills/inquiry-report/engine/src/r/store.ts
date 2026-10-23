// One research run is one folder under data/runs/<id>/:
//   events.jsonl      every record, append only, hash-chained
//   archive/<sha>.txt the text of every fetched source
//   hits-<S>.json     what each search returned
//   report.json, report.html  written by `build`
// Commands keep no state of their own; each one reads the folder fresh.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { canonicalJson, sha256 } from "../ledger/hash.ts";
import { DATA_DIR } from "../ledger/db.ts";

export const PROJECT_ROOT = path.join(import.meta.dirname, "..", "..");
export const RUNS_DIR = path.join(DATA_DIR, "runs");

export type By = "user" | "claude" | "script";
export type Event = { seq: number; at: string; kind: string; by: By; prev: string | null; hash: string; [field: string]: any };

export const KINDS = [
  "request", "frame", "note", "plan", "approve", "search", "lead", "family", "fetch",
  "label", "judge", "origin_check", "decide", "report", "limit",
] as const;
const RESERVED = ["seq", "at", "kind", "by", "prev", "hash"];

export class RunError extends Error {}

export class Run {
  readonly dir: string;
  private readonly now: () => Date;
  constructor(dir: string, now: () => Date = () => new Date()) {
    this.dir = dir;
    this.now = now;
  }

  get id(): string { return path.basename(this.dir); }
  get eventsPath(): string { return path.join(this.dir, "events.jsonl"); }

  events(): Event[] {
    if (!existsSync(this.eventsPath)) return [];
    return readFileSync(this.eventsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  append(kind: (typeof KINDS)[number], by: By, body: Record<string, unknown>): Event {
    for (const k of RESERVED) if (k in body) throw new RunError(`field "${k}" is set by the store`);
    const all = this.events();
    const last = all[all.length - 1];
    const e = { ...body, seq: all.length + 1, at: this.now().toISOString(), kind, by, prev: last ? last.hash : null } as Omit<Event, "hash">;
    const full = { ...e, hash: sha256(canonicalJson(e)) } as Event;
    appendFileSync(this.eventsPath, JSON.stringify(full) + "\n");
    return full;
  }

  /** Next free id with this prefix (S1, R1, E1 ...), counted over every record that carries an id. */
  nextId(prefix: "S" | "R" | "E" | "L" | "F" | "N"): string {
    const re = new RegExp(`^${prefix}(\\d+)$`);
    let max = 0;
    for (const e of this.events()) {
      const m = typeof e.id === "string" ? e.id.match(re) : null;
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}${max + 1}`;
  }

  /** Saves fetched text under its own hash and returns the hash. */
  archive(text: string): string {
    const sha = sha256(text);
    mkdirSync(path.join(this.dir, "archive"), { recursive: true });
    writeFileSync(path.join(this.dir, "archive", `${sha}.txt`), text);
    return sha;
  }

  /** The archived text of a source, or an error if it was never fetched. */
  archived(sourceId: string): string {
    const f = this.fetchOf(sourceId);
    if (!f?.sha256) throw new RunError(`${sourceId} has no archived text`);
    return readFileSync(path.join(this.dir, "archive", `${f.sha256}.txt`), "utf8");
  }

  fetchOf(sourceId: string): Event | undefined {
    return this.events().find((e) => isFetch(e) && e.id === sourceId);
  }

  writeFile(name: string, content: string): string {
    const p = path.join(this.dir, name);
    writeFileSync(p, content);
    return p;
  }
}

/** Fetch records. The first trial run stored the source kind in `kind`; read those too. */
export function isFetch(e: Event): boolean {
  if (e.kind === "fetch") return true;
  return ["official", "media", "web", "sns", "paper"].includes(e.kind) && /^R\d+$/.test(e.id ?? "");
}

export function sourceKindOf(e: Event): string {
  return e.kind === "fetch" ? e.source_kind : e.kind;
}

/** Problems in the hash chain; empty when every record links to the one before it. */
export function verifyChain(events: Event[]): string[] {
  const problems: string[] = [];
  let prev: string | null = null;
  events.forEach((e, i) => {
    const { hash, ...rest } = e;
    if (e.seq !== i + 1) problems.push(`seq ${e.seq} at line ${i + 1}`);
    if (e.prev !== prev) problems.push(`seq ${e.seq}: prev does not match the line before`);
    if (sha256(canonicalJson(rest)) !== hash) problems.push(`seq ${e.seq}: hash does not match its content`);
    prev = hash;
  });
  return problems;
}

export function runIdFor(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `req-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function createRun(question: string, root = RUNS_DIR, now: () => Date = () => new Date()): Run {
  const run = new Run(path.join(root, runIdFor(now())), now);
  mkdirSync(run.dir, { recursive: true });
  writeFileSync(path.join(root, ".current"), run.id);
  run.append("request", "user", { question });
  return run;
}

/** The named run, or the one `new` made last. */
export function openRun(id?: string, root = RUNS_DIR, now?: () => Date): Run {
  const runId = id ?? (existsSync(path.join(root, ".current")) ? readFileSync(path.join(root, ".current"), "utf8").trim() : "");
  if (!runId) throw new RunError("no run: start one with `new` or pass --run <id>");
  const dir = path.join(root, runId);
  if (!existsSync(path.join(dir, "events.jsonl"))) throw new RunError(`run ${runId} not found in ${root}`);
  return new Run(dir, now);
}
