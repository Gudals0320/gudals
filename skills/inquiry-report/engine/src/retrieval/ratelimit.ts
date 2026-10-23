// Per-site rate limits, enforced in code (handoff principle 9). Every outside
// request reserves a time slot here first. Reservations live in their own
// SQLite file so several runs in different processes share one schedule:
// a reservation is taken inside BEGIN IMMEDIATE, so two processes can never
// pick the same slot for the same site. This file is an operating log, not
// research state; the ledger records each request as an ActionTaken.

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, PROJECT_ROOT } from "../ledger/db.ts";

export type SiteRule = {
  group: string;
  hosts: string[];
  min_interval_ms: number;
  per_hour?: number | null;
  per_day?: number | null;
  key_env?: string;
  min_interval_ms_with_key?: number;
  publisher?: boolean;
  /** M0 preflight confirmed institutional full text here, so a paywall means the login lapsed. */
  institutional_verified?: boolean;
};

export type SitesConfig = {
  default: { min_interval_ms: number; per_hour?: number | null; per_day?: number | null };
  groups: SiteRule[];
  slots: Record<string, { concurrency: number; lease_ms: number }>;
  max_wait_ms: number;
};

export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
};

export const DEFAULT_SITES_PATH = path.join(PROJECT_ROOT, "config", "sites.json");
export const DEFAULT_RATELIMIT_DB = path.join(DATA_DIR, "ratelimit.db");

export function loadSitesConfig(file = DEFAULT_SITES_PATH): SitesConfig {
  return JSON.parse(readFileSync(file, "utf8")) as SitesConfig;
}

export class RateLimitExceeded extends Error {
  readonly group: string;
  readonly waitMs: number;
  constructor(group: string, waitMs: number, why: string) {
    super(`rate limit for ${group}: ${why} (would wait ${Math.round(waitMs / 1000)} s)`);
    this.name = "RateLimitExceeded";
    this.group = group;
    this.waitMs = waitMs;
  }
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

export type Reservation = { group: string; at: number; waited_ms: number };

export type RateLimiter = {
  ruleFor(urlOrHost: string): SiteRule;
  /** Waits until this site may be contacted, or throws RateLimitExceeded. */
  reserve(urlOrHost: string): Promise<Reservation>;
  /** Cross-process concurrency slot (e.g. Claude calls). Returns a release function. */
  acquireSlot(name: string): Promise<() => void>;
  /** Stop a site group until the end of the local day (account-limit signs on X or Threads). */
  blockForToday(urlOrHost: string, reason: string): void;
  /** Reason a group is blocked today, or null. */
  blockedReason(urlOrHost: string): string | null;
  close(): void;
};

export function hostOf(urlOrHost: string): string {
  try {
    return new URL(urlOrHost).hostname.toLowerCase();
  } catch {
    return urlOrHost.toLowerCase();
  }
}

/** A host matches a rule host exactly or as a subdomain ("www.sciencedirect.com" matches "sciencedirect.com"). */
export function matchRule(config: SitesConfig, host: string, env: Record<string, string | undefined> = process.env): SiteRule {
  const h = hostOf(host);
  let path = "";
  try { path = new URL(host).pathname; } catch { /* a bare host */ }
  const bare = h.replace(/^www\./, "");
  // "host/path" entries match a path prefix, so one host can have page and API groups.
  const hit = (x: string) => {
    if (!x.includes("/")) return h === x || h.endsWith(`.${x}`);
    const [xh, ...rest] = x.split("/");
    return (bare === xh || h.endsWith(`.${xh}`)) && path.startsWith(`/${rest.join("/")}`);
  };
  const rule = config.groups.find((g) => g.hosts.some((x) => x.includes("/") && hit(x))) ?? config.groups.find((g) => g.hosts.some((x) => !x.includes("/") && hit(x)));
  if (!rule) return { group: `host:${h}`, hosts: [h], ...config.default };
  if (rule.key_env && env[rule.key_env] && rule.min_interval_ms_with_key !== undefined) {
    return { ...rule, min_interval_ms: rule.min_interval_ms_with_key };
  }
  return rule;
}

export type LimiterOptions = {
  dbPath?: string;
  config?: SitesConfig;
  clock?: Clock;
  env?: Record<string, string | undefined>;
  /** Poll interval while waiting for a slot. */
  slotPollMs?: number;
};

export function openRateLimiter(opts: LimiterOptions = {}): RateLimiter {
  const dbPath = opts.dbPath ?? DEFAULT_RATELIMIT_DB;
  const config = opts.config ?? loadSitesConfig();
  const clock = opts.clock ?? realClock;
  const env = opts.env ?? process.env;
  const pollMs = opts.slotPollMs ?? 500;
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 10000");
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS reservations (grp TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS reservations_grp_at ON reservations (grp, at);
    CREATE TABLE IF NOT EXISTS slots (name TEXT NOT NULL, holder TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS blocks (grp TEXT NOT NULL, until INTEGER NOT NULL, reason TEXT NOT NULL);
  `);
  const endOfDay = (ms: number) => { const d = new Date(ms); d.setHours(24, 0, 0, 0); return d.getTime(); };
  const blocked = (grp: string): string | null => {
    const r = db.prepare("SELECT reason FROM blocks WHERE grp = ? AND until > ? ORDER BY until DESC LIMIT 1").get(grp, clock.now());
    return r ? String(r.reason) : null;
  };

  function tx<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Earliest time >= t at which a window of `span` holds fewer than `cap` reservations. */
  function windowStart(times: number[], t: number, span: number, cap: number | null | undefined): number {
    if (!cap) return t;
    const inWindow = times.filter((x) => x > t - span);
    if (inWindow.length < cap) return t;
    // The slot opens when the oldest reservation that keeps us at the cap leaves the window.
    return Math.max(t, inWindow[inWindow.length - cap] + span);
  }

  let holderSeq = 0;

  return {
    ruleFor: (u) => matchRule(config, u, env),

    async reserve(urlOrHost) {
      const rule = matchRule(config, urlOrHost, env);
      const now = clock.now();
      const why = blocked(rule.group);
      if (why) throw new RateLimitExceeded(rule.group, endOfDay(now) - now, `stopped for today: ${why}`);
      const at = tx(() => {
        const rows = db.prepare("SELECT at FROM reservations WHERE grp = ? AND at > ? ORDER BY at").all(rule.group, now - DAY);
        const times = rows.map((r) => Number(r.at));
        let t = Math.max(now, times.length ? times[times.length - 1] + rule.min_interval_ms : now);
        // Caps can push t later, and a later t can only free capacity, so two passes settle it.
        for (let i = 0; i < 2; i++) {
          t = windowStart(times, t, DAY, rule.per_day);
          t = windowStart(times, t, HOUR, rule.per_hour);
        }
        if (t - now > config.max_wait_ms) {
          const why = rule.per_day && times.filter((x) => x > now - DAY).length >= rule.per_day ? "daily cap reached" : "hourly cap or queue too long";
          throw new RateLimitExceeded(rule.group, t - now, why);
        }
        db.prepare("INSERT INTO reservations (grp, at) VALUES (?, ?)").run(rule.group, t);
        db.prepare("DELETE FROM reservations WHERE at < ?").run(now - 2 * DAY);
        return t;
      });
      const waited = at - now;
      if (waited > 0) await clock.sleep(waited);
      return { group: rule.group, at, waited_ms: waited };
    },

    async acquireSlot(name) {
      const spec = config.slots[name];
      if (!spec) throw new Error(`no slot config for ${name}`);
      const holder = `${process.pid}:${++holderSeq}:${clock.now()}`;
      for (;;) {
        const got = tx(() => {
          const now = clock.now();
          db.prepare("DELETE FROM slots WHERE expires < ?").run(now);
          const n = Number(db.prepare("SELECT count(*) AS n FROM slots WHERE name = ?").get(name)!.n);
          if (n >= spec.concurrency) return false;
          db.prepare("INSERT INTO slots (name, holder, expires) VALUES (?, ?, ?)").run(name, holder, now + spec.lease_ms);
          return true;
        });
        if (got) break;
        await clock.sleep(pollMs);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        tx(() => db.prepare("DELETE FROM slots WHERE holder = ?").run(holder));
      };
    },

    blockForToday(urlOrHost, reason) {
      const rule = matchRule(config, urlOrHost, env);
      tx(() => db.prepare("INSERT INTO blocks (grp, until, reason) VALUES (?, ?, ?)").run(rule.group, endOfDay(clock.now()), reason));
    },

    blockedReason: (urlOrHost) => blocked(matchRule(config, urlOrHost, env).group),

    close: () => db.close(),
  };
}
