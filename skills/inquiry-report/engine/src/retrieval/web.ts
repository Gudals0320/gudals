// Web and social channels (M2 v2). Search engines, X and Threads are read in
// the user's Ego Lite browser through fixed, read-only templates; Reddit goes
// through its public JSON without cookies; pages that leads point to are
// fetched by Node without cookies. Every request reserves a rate-limit slot
// first, and signs of a bot check, login wall or account limit stop that
// channel and are reported, never worked around (handoff principles 8, 9).

import { egoPath, RESULT_TAG, runEgo as defaultRunEgo, type EgoRun } from "../preflight/egolite.ts";
import { ACCOUNT_LIMIT_SIGNS, DECLINE_COOKIES, SCROLL_ONCE } from "./browser.ts";
import { politeFetch, redactUrl, textOf, type HttpEnv } from "./http.ts";
import type { RateLimiter } from "./ratelimit.ts";
import { decodeEntities } from "./xml.ts";

export type Platform = "web_ddg" | "web_google" | "x" | "threads" | "reddit" | "page";

export type Post = {
  platform: Platform;
  url: string;
  author_handle: string | null;
  posted_at: string | null;
  text: string;
  links: string[];
  title?: string | null;
};

export type ChannelResult = {
  platform: Platform;
  query: string;
  url: string;
  ok: boolean;
  /** challenge = bot check, login = login wall, limited = account limit signs, empty = page read but nothing found. */
  problem: "challenge" | "login" | "limited" | "empty" | "error" | null;
  detail: string | null;
  posts: Post[];
  waited_ms: number;
  spaceId: number | null;
};

export type WebDeps = { runEgo?: (script: string, timeoutMs?: number) => Promise<EgoRun>; space: string };

const tag = JSON.stringify(RESULT_TAG);

// Extractors run inside the page via page.evaluate(); they are serialized with
// toString(), so they must stay self-contained and free of type annotations.

export function extractDdg() {
  const out = [];
  for (const r of Array.from(document.querySelectorAll(".result, .web-result, article[data-testid=result]"))) {
    const a = r.querySelector("a.result__a, a[data-testid=result-title-a], h2 a");
    if (!a) continue;
    const s = r.querySelector(".result__snippet, [data-result=snippet], div[data-testid=result-snippet]");
    out.push({ title: (a.textContent || "").trim(), href: a.getAttribute("href") || "", snippet: s ? (s.textContent || "").trim() : "" });
  }
  return out.slice(0, 15);
}

export function extractGoogle() {
  const out = [];
  for (const h of Array.from(document.querySelectorAll("a h3"))) {
    const a = h.closest("a");
    if (!a) continue;
    const box = a.closest("div[data-hveid], div.g") || a.parentElement;
    const s = box ? box.querySelector("div[data-sncf], .VwiC3b, span.aCOpRe") : null;
    out.push({ title: (h.textContent || "").trim(), href: a.getAttribute("href") || "", snippet: s ? (s.textContent || "").trim() : "" });
  }
  return out.slice(0, 15);
}

export function extractX() {
  const out = [];
  for (const art of Array.from(document.querySelectorAll('article[data-testid="tweet"]'))) {
    const t = art.querySelector('[data-testid="tweetText"]');
    const time = art.querySelector("time");
    const link = time ? time.closest("a") : art.querySelector('a[href*="/status/"]');
    const href = link ? link.getAttribute("href") || "" : "";
    const m = href.match(/^\/([^/]+)\/status\//);
    const links = Array.from(art.querySelectorAll('[data-testid="tweetText"] a[href^="http"], a[href^="https://t.co"]'))
      .map((a) => (a.textContent || "").replace(/…$/, "").trim() || a.getAttribute("href") || "");
    out.push({ url: href ? "https://x.com" + href : "", handle: m ? m[1] : null, time: time ? time.getAttribute("datetime") : null, text: t ? t.innerText : "", links });
  }
  return out.slice(0, 20);
}

export function extractThreads() {
  const out = [];
  const seen = new Set();
  for (const a of Array.from(document.querySelectorAll('a[href*="/post/"]'))) {
    const href = a.getAttribute("href") || "";
    if (seen.has(href)) continue;
    seen.add(href);
    const box = a.closest("div[data-pressable-container]") || a.closest("article") || a.parentElement && a.parentElement.parentElement;
    if (!box) continue;
    const m = href.match(/^\/@([^/]+)\/post\//);
    const time = box.querySelector("time");
    const links = Array.from(box.querySelectorAll('a[href^="http"]')).map((x) => x.getAttribute("href") || "").filter((x) => !/threads\.(net|com)/.test(x));
    out.push({ url: "https://www.threads.com" + href, handle: m ? m[1] : null, time: time ? time.getAttribute("datetime") : null, text: (box.innerText || "").slice(0, 3000), links });
  }
  return out.slice(0, 20);
}

function pageScript(space: string, url: string, extractor: () => unknown, scrolls: number): string {
  return `
const task = await taskSpace(${JSON.stringify(space)});
if ((await task.pages()).length === 0) await task.newPage();
const page = (await task.pages())[0];
const out = { spaceId: task.spaceId, items: null, head: "", title: "", error: null, cookies: null };
try {
  await page.goto(${JSON.stringify(url)});
  try { await page.waitForLoadState(); } catch {}
  await page.waitForTimeout(4000);
  try { out.cookies = await page.evaluate(() => ${DECLINE_COOKIES}); } catch {}
  for (let i = 0; i < ${scrolls}; i++) { await page.evaluate(() => ${SCROLL_ONCE}); await page.waitForTimeout(2500); }
  out.title = await page.evaluate(() => document.title.slice(0, 200));
  out.head = await page.evaluate(() => (document.body ? document.body.innerText : "").slice(0, 3000));
  out.items = await page.evaluate(${extractor.toString()});
} catch (e) { out.error = String(e && e.message || e).slice(0, 300); }
console.log(${tag} + JSON.stringify(out));
`;
}

const handOffScript = (spaceId: number) => `const task = await taskSpace(${spaceId}); await task.handOff();`;

const CHALLENGE = /verify you are human|are you a robot|unusual traffic|captcha|checking your browser|i'm not a robot|로봇이 아닙니다|자동화된 요청/i;
const LOGIN = /(log in|sign in|sign up|로그인|가입)/i;

type Raw = { spaceId: number; items: unknown[] | null; head: string; title: string; error: string | null };

async function visit(limiter: RateLimiter, deps: WebDeps, platform: Platform, query: string, url: string, extractor: () => unknown, scrolls = 0): Promise<{ raw: Raw | null; base: Omit<ChannelResult, "posts"> }> {
  const r = await limiter.reserve(url);
  const base = { platform, query, url: redactUrl(url), ok: false, problem: null as ChannelResult["problem"], detail: null as string | null, waited_ms: r.waited_ms, spaceId: null as number | null };
  let raw: Raw | null = null;
  try {
    raw = ((await (deps.runEgo ?? defaultRunEgo)(pageScript(deps.space, url, extractor, scrolls), 90_000)).results[0] as Raw | undefined) ?? null;
  } catch (e) {
    return { raw: null, base: { ...base, problem: "error", detail: `ego-browser: ${e instanceof Error ? e.message : e}` } };
  }
  if (!raw) return { raw: null, base: { ...base, problem: "error", detail: "no result from ego-browser" } };
  base.spaceId = raw.spaceId;
  if (raw.error) return { raw, base: { ...base, problem: "error", detail: raw.error } };
  const head = `${raw.title}\n${raw.head}`;
  const items = raw.items ?? [];
  if (CHALLENGE.test(head)) return { raw, base: { ...base, problem: "challenge", detail: `bot check on ${platform}: "${raw.title}"` } };
  if (ACCOUNT_LIMIT_SIGNS.test(head)) return { raw, base: { ...base, problem: "limited", detail: `account limit signs on ${platform}` } };
  if (!items.length && (platform === "x" || platform === "threads") && LOGIN.test(raw.head.slice(0, 600))) {
    return { raw, base: { ...base, problem: "login", detail: `${platform} shows a login wall` } };
  }
  return { raw, base: { ...base, ok: true, problem: items.length ? null : "empty", detail: items.length ? null : "no results on the page" } };
}

/** Hand the browser space to the user after a bot check, login wall or account-limit sign. */
export async function handOff(deps: WebDeps, spaceId: number | null): Promise<void> {
  if (spaceId === null) return;
  await (deps.runEgo ?? defaultRunEgo)(handOffScript(spaceId)).catch(() => undefined);
}

/** DuckDuckGo result links are redirects; the target is in the uddg parameter. */
export function unwrapDdg(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com/");
    const t = u.searchParams.get("uddg");
    return t ? decodeURIComponent(t) : u.toString();
  } catch {
    return href;
  }
}

export function unwrapGoogle(href: string): string {
  try {
    const u = new URL(href, "https://www.google.com/");
    return u.pathname === "/url" ? u.searchParams.get("q") ?? u.toString() : u.toString();
  } catch {
    return href;
  }
}

type SearchItem = { title: string; href: string; snippet: string };

export async function webSearch(limiter: RateLimiter, deps: WebDeps, query: string, engine: "ddg" | "google" = "ddg"): Promise<ChannelResult> {
  const url = engine === "ddg"
    ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=kr-kr`
    : `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=ko&num=10`;
  const { raw, base } = await visit(limiter, deps, engine === "ddg" ? "web_ddg" : "web_google", query, url, engine === "ddg" ? extractDdg : extractGoogle);
  const items = ((raw?.items ?? []) as SearchItem[]).filter((i) => i.href);
  const posts: Post[] = items.map((i) => {
    const target = engine === "ddg" ? unwrapDdg(i.href) : unwrapGoogle(i.href);
    return { platform: base.platform, url: target, author_handle: null, posted_at: null, title: i.title, text: `${i.title}\n${i.snippet}`, links: [target] };
  }).filter((p) => /^https?:/.test(p.url) && !/duckduckgo\.com|google\.com\/(search|url)/.test(p.url));
  return { ...base, posts };
}

type XItem = { url: string; handle: string | null; time: string | null; text: string; links: string[] };

export async function searchX(limiter: RateLimiter, deps: WebDeps, query: string): Promise<ChannelResult> {
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=top`;
  const { raw, base } = await visit(limiter, deps, "x", query, url, extractX, 1);
  const posts = ((raw?.items ?? []) as XItem[]).filter((i) => i.url && i.text.trim()).map((i) => ({
    platform: "x" as const, url: i.url, author_handle: i.handle, posted_at: i.time, text: i.text, links: i.links,
  }));
  return { ...base, posts };
}

export async function searchThreads(limiter: RateLimiter, deps: WebDeps, query: string): Promise<ChannelResult> {
  const url = `https://www.threads.com/search?q=${encodeURIComponent(query)}&serp_type=default`;
  const { raw, base } = await visit(limiter, deps, "threads", query, url, extractThreads, 1);
  const posts = ((raw?.items ?? []) as XItem[]).filter((i) => i.url && i.text.trim()).map((i) => ({
    platform: "threads" as const, url: i.url, author_handle: i.handle, posted_at: i.time, text: i.text, links: i.links,
  }));
  return { ...base, posts };
}

type RedditChild = { data?: { title?: string; selftext?: string; author?: string; created_utc?: number; permalink?: string; url?: string; is_self?: boolean } };

/** Reddit's public JSON, no cookies. A refusal is reported; the page fallback goes through Ego Lite. */
export async function searchReddit(http: HttpEnv, limiter: RateLimiter, deps: WebDeps, query: string): Promise<ChannelResult> {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=25&t=all&raw_json=1`;
  const base = { platform: "reddit" as const, query, url, spaceId: null };
  try {
    const r = await politeFetch(http, url, { headers: { accept: "application/json" } });
    if (r.ok) {
      const j = JSON.parse(textOf(r)) as { data?: { children?: RedditChild[] } };
      const posts: Post[] = (j.data?.children ?? []).map((c) => c.data ?? {}).filter((d) => d.permalink).map((d) => ({
        platform: "reddit", url: `https://www.reddit.com${d.permalink}`, author_handle: d.author ?? null,
        posted_at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
        text: `${d.title ?? ""}\n\n${(d.selftext ?? "").slice(0, 4000)}`.trim(), links: d.is_self === false && d.url ? [d.url] : [],
      }));
      return { ...base, ok: true, problem: posts.length ? null : "empty", detail: null, posts, waited_ms: r.waited_ms };
    }
    if (r.status !== 403 && r.status !== 429) return { ...base, ok: false, problem: "error", detail: `HTTP ${r.status}`, posts: [], waited_ms: r.waited_ms };
  } catch (e) {
    return { ...base, ok: false, problem: "error", detail: String(e instanceof Error ? e.message : e), posts: [], waited_ms: 0 };
  }
  // JSON refused (403 for clients without an account, seen 2026-10-22): read reddit.com's
  // logged-out search page instead (old.reddit now requires an account).
  const page = `https://www.reddit.com/search/?q=${encodeURIComponent(query)}&type=posts`;
  const { raw, base: b } = await visit(limiter, deps, "reddit", query, page, extractRedditSearch);
  const posts = ((raw?.items ?? []) as XItem[]).map((i) => ({ platform: "reddit" as const, url: i.url, author_handle: i.handle, posted_at: i.time, text: i.text, links: i.links }));
  return { ...b, posts, detail: b.detail ?? "public JSON refused; read reddit.com search page" };
}

export function extractRedditSearch() {
  const out = [];
  const seen = new Set();
  for (const a of Array.from(document.querySelectorAll('a[href*="/comments/"]'))) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/^(?:https:\/\/www\.reddit\.com)?(\/r\/[^/]+\/comments\/[^/]+\/[^/?#]*)/);
    const t = (a.textContent || "").trim();
    if (!m || seen.has(m[1]) || t.length < 10) continue;
    seen.add(m[1]);
    const box = a.closest('[data-testid="search-post-unit"]') || a.closest("search-telemetry-tracker") || a.parentElement;
    const time = box ? box.querySelector("faceplate-timeago time, time") : null;
    out.push({ url: "https://www.reddit.com" + m[1], handle: null, time: time ? time.getAttribute("datetime") : null, text: t, links: [] });
  }
  return out.slice(0, 20);
}

/** Readable text of an HTML page: scripts, styles and page chrome removed. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const desc = decodeEntities(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? "");
  let body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  body = body
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body).split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, text: desc && !text.includes(desc) ? `${desc}\n\n${text}` : text };
}

export type PageResult = { ok: boolean; url: string; final_url: string; status: number; title: string; text: string; content_type: string; reason: string | null; waited_ms: number; pdf: Buffer | null };

const MAX_BYTES = 10 * 1024 * 1024;
export const BOT_PAGE = /^(client challenge|just a moment|attention required|access denied|are you a robot|verify you are human|security check)/i;

/** A page a lead points to, fetched by Node without cookies (never in the logged-in browser). */
export async function fetchPage(http: HttpEnv, url: string): Promise<PageResult> {
  const fail = (reason: string, status = 0, waited = 0): PageResult => ({ ok: false, url, final_url: url, status, title: "", text: "", content_type: "", reason, waited_ms: waited, pdf: null });
  if (!/^https?:\/\//i.test(url)) return fail("not an http(s) URL");
  let r;
  try {
    r = await politeFetch(http, url, { headers: { accept: "text/html,application/xhtml+xml,application/pdf;q=0.9" } });
  } catch (e) {
    return fail(`request failed: ${e instanceof Error ? e.message : e}`);
  }
  if (!r.ok) return fail(`HTTP ${r.status}`, r.status, r.waited_ms);
  if (r.body.length > MAX_BYTES) return fail("larger than 10 MB", r.status, r.waited_ms);
  const ct = r.contentType.toLowerCase();
  if (ct.includes("pdf") || r.body.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { ok: true, url, final_url: url, status: r.status, title: "", text: "", content_type: "application/pdf", reason: null, waited_ms: r.waited_ms, pdf: r.body };
  }
  if (!ct.includes("html") && !ct.includes("text")) return fail(`unsupported content type ${ct || "unknown"}`, r.status, r.waited_ms);
  const { title, text } = htmlToText(r.body.toString("utf8"));
  // Bot-check interstitials are not sources (seen as evidence in the M2 evaluation).
  if (BOT_PAGE.test(title) || BOT_PAGE.test(text.slice(0, 400))) return fail(`bot check page ("${title.slice(0, 60)}")`, r.status, r.waited_ms);
  if (text.length < 200) return fail(`page text too short (${text.length} chars)`, r.status, r.waited_ms);
  return { ok: true, url, final_url: url, status: r.status, title, text, content_type: ct, reason: null, waited_ms: r.waited_ms, pdf: null };
}

export { egoPath };
