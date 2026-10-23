// The Korean web modules never call fetch() themselves: they take a KrFetch.
// In the main pipeline that is politeFetch() bound to its HttpEnv (same
// result shape), so the per-site limits in config/sites.json apply. For the
// standalone spike, spikeFetcher() below enforces its own per-host interval
// and a hard request cap. Signs of a bot check or login wall stop the caller;
// they are reported, never worked around (handoff principles 8, 9).

export type KrResponse = { url: string; status: number; ok: boolean; contentType: string; body: Buffer };
export type KrFetch = (url: string, init?: RequestInit) => Promise<KrResponse>;

/** Thrown when a page is a bot check, a login wall, or a rate-limit answer. */
export class BlockedError extends Error {
  readonly kind: "challenge" | "login" | "limited";
  readonly url: string;
  constructor(kind: "challenge" | "login" | "limited", url: string, detail: string) {
    super(`${kind} at ${url}: ${detail}`);
    this.name = "BlockedError";
    this.kind = kind;
    this.url = url;
  }
}

export class RequestBudgetExceeded extends Error {
  constructor(max: number) {
    super(`request budget of ${max} used up`);
    this.name = "RequestBudgetExceeded";
  }
}

const CHALLENGE = /captcha|cf-chl|challenge-platform|just a moment\.\.\.|attention required|보안문자|자동입력 방지|비정상적인 (접근|트래픽)|접근이 (차단|제한)/i;
const LOGIN = /<title>[^<]*(로그인|log ?in|sign ?in)[^<]*<\/title>/i;

/** Classifies a response that should not be read as content, or null when it looks normal. */
export function detectBlock(res: KrResponse): { kind: "challenge" | "login" | "limited"; detail: string } | null {
  if (res.status === 429) return { kind: "limited", detail: "HTTP 429" };
  const isHtml = /html/i.test(res.contentType);
  const head = isHtml ? res.body.subarray(0, 200_000).toString("utf8") : "";
  if (res.status === 403 || res.status === 503) {
    return { kind: "challenge", detail: `HTTP ${res.status}${CHALLENGE.test(head) ? " with challenge page" : ""}` };
  }
  if (!isHtml) return null;
  // A small page that matches is a gate; a long article that merely mentions "captcha" is not.
  const m = head.match(CHALLENGE);
  if (m && res.body.length < 60_000) return { kind: "challenge", detail: `page text "${m[0]}"` };
  if (LOGIN.test(head)) return { kind: "login", detail: "login page title" };
  return null;
}

/** Throws BlockedError when detectBlock() finds a gate. */
export function assertNotBlocked(res: KrResponse): KrResponse {
  const b = detectBlock(res);
  if (b) throw new BlockedError(b.kind, res.url, b.detail);
  return res;
}

export type SpikeLogEntry = { at: string; url: string; host: string; status: number | null; bytes: number; ms: number; waited_ms: number; error?: string };

export type SpikeFetcherOptions = {
  /** Minimum gap between two requests to the same host suffix, longest match wins. */
  intervals: Record<string, number>;
  defaultIntervalMs: number;
  maxRequests: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
};

export type SpikeFetcher = KrFetch & { log: SpikeLogEntry[]; count(): number };

/** Same User-Agent as politeFetch, so the spike looks like the real pipeline to sites. */
export const KR_USER_AGENT = "inquiry/0.2 (personal local research tool)";

export function intervalFor(host: string, intervals: Record<string, number>, fallback: number): { key: string; ms: number } {
  let best: { key: string; ms: number } | null = null;
  for (const [suffix, ms] of Object.entries(intervals)) {
    if ((host === suffix || host.endsWith(`.${suffix}`)) && (!best || suffix.length > best.key.length)) best = { key: suffix, ms };
  }
  return best ?? { key: host, ms: fallback };
}

export function spikeFetcher(opts: SpikeFetcherOptions): SpikeFetcher {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms))));
  const last = new Map<string, number>();
  const log: SpikeLogEntry[] = [];
  let used = 0;

  const f = (async (url: string, init: RequestInit = {}) => {
    if (used >= opts.maxRequests) throw new RequestBudgetExceeded(opts.maxRequests);
    used++;
    const host = new URL(url).hostname.toLowerCase();
    const { key, ms } = intervalFor(host, opts.intervals, opts.defaultIntervalMs);
    const prev = last.get(key);
    const wait = prev === undefined ? 0 : Math.max(0, prev + ms - now());
    if (wait > 0) await sleep(wait);
    last.set(key, now());
    const t0 = now();
    try {
      const res = await doFetch(url, {
        redirect: "follow",
        ...init,
        headers: { "user-agent": opts.userAgent ?? KR_USER_AGENT, "accept-language": "ko-KR,ko;q=0.9,en;q=0.5", ...(init.headers as Record<string, string> | undefined) },
        signal: init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      const body = Buffer.from(await res.arrayBuffer());
      last.set(key, now());
      log.push({ at: new Date(t0).toISOString(), url, host, status: res.status, bytes: body.length, ms: now() - t0, waited_ms: wait });
      return { url: res.url || url, status: res.status, ok: res.ok, contentType: res.headers.get("content-type") ?? "", body };
    } catch (e) {
      last.set(key, now());
      log.push({ at: new Date(t0).toISOString(), url, host, status: null, bytes: 0, ms: now() - t0, waited_ms: wait, error: (e as Error).message });
      throw e;
    }
  }) as SpikeFetcher;
  f.log = log;
  f.count = () => used;
  return f;
}
