// politeFetch(): the single exit for outside HTTP requests. It reserves a slot
// with the per-site rate limiter before every request, so no code path can
// send requests to a site faster than config/sites.json allows.

import type { RateLimiter } from "./ratelimit.ts";

export type HttpEnv = { limiter: RateLimiter; fetch?: typeof fetch; timeoutMs?: number };

export type HttpResult = {
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  body: Buffer;
  group: string;
  waited_ms: number;
  ms: number;
};

const USER_AGENT = "inquiry/0.2 (personal local research tool)";

/** URL without credentials, for anything that is recorded or printed. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ["api_key", "apikey", "key", "token"]) if (u.searchParams.has(k)) u.searchParams.set(k, "REDACTED");
    return u.toString();
  } catch {
    return url;
  }
}

export async function politeFetch(env: HttpEnv, url: string, init: RequestInit = {}): Promise<HttpResult> {
  const r = await env.limiter.reserve(url);
  const t0 = Date.now();
  const doFetch = env.fetch ?? fetch;
  const res = await doFetch(url, {
    redirect: "follow",
    ...init,
    headers: { "user-agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
    signal: init.signal ?? AbortSignal.timeout(env.timeoutMs ?? 60_000),
  });
  const body = Buffer.from(await res.arrayBuffer());
  return {
    url, status: res.status, ok: res.ok, contentType: res.headers.get("content-type") ?? "",
    body, group: r.group, waited_ms: r.waited_ms, ms: Date.now() - t0,
  };
}

export const textOf = (r: HttpResult) => r.body.toString("utf8");
