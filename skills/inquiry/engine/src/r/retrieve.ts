// Search and fetch for the research toolbox. Everything goes through the
// project's rate limits (config/sites.json for the web, 3 s per government
// host). Pages and files are untrusted data: they are only turned into text.
// A bot check, login wall or rate-limit answer stops the call; nothing is
// worked around.

import { openRateLimiter } from "../retrieval/ratelimit.ts";
import { fetchPage, webSearch } from "../retrieval/web.ts";
import { spikeFetcher } from "../retrieval/kr/http.ts";
import { downloadAttachment, fetchGovDoc, searchKdca, searchKoreaKr } from "../retrieval/kr/gov.ts";
import { extractText } from "../retrieval/kr/extract.ts";

export const CHANNELS = ["ddg", "kdca", "korea_kr"] as const;
export type Channel = (typeof CHANNELS)[number];
export type Hit = { url: string; title: string; text: string; date: string | null };
export type SearchResult = { hits: Hit[]; problem: string | null };
export type Fetched = { title: string; text: string; note: string | null };

export type RetrieveDeps = {
  search?: (channel: Channel, query: string, space: string) => Promise<SearchResult>;
  fetch?: (url: string) => Promise<Fetched>;
};

const krFetch = () => spikeFetcher({ intervals: { "kdca.go.kr": 3000, "korea.kr": 3000 }, defaultIntervalMs: 3000, maxRequests: 60 });
const GOV = /(^|\.)kdca\.go\.kr$|(^|\.)korea\.kr$/;

async function defaultSearch(channel: Channel, query: string, space: string): Promise<SearchResult> {
  if (channel === "ddg") {
    const limiter = openRateLimiter();
    try {
      const r = await webSearch(limiter, { space }, query, "ddg");
      return { problem: r.problem, hits: r.posts.map((p) => ({ url: p.url, title: p.title ?? "", text: p.text, date: null })) };
    } finally {
      limiter.close();
    }
  }
  const r = channel === "kdca"
    ? await searchKdca(krFetch(), query)
    : await searchKoreaKr(krFetch(), query, { startDate: "2020-01-01", endDate: new Date().toISOString().slice(0, 10) });
  return { problem: r.items.length ? null : "empty", hits: r.items.map((i) => ({ url: i.url, title: i.title, text: i.lead ? `${i.title}\n${i.lead}` : i.title, date: i.date })) };
}

/** Government board posts come with their attachment text (PDF first, then HWPX, then HWP). */
async function defaultFetch(url: string): Promise<Fetched> {
  if (GOV.test(new URL(url).hostname)) {
    const f = krFetch();
    const doc = await fetchGovDoc(f, { source: /kdca/.test(url) ? "kdca" : "korea_kr", url });
    let text = `${doc.title}\n${[doc.date, doc.agency, doc.department].filter(Boolean).join(" ")}\n${doc.body_text}`;
    const pick = ["pdf", "hwpx", "hwp"].map((ext) => doc.attachments.find((a) => a.ext === ext)).find(Boolean);
    let note: string | null = null;
    if (pick) {
      const d = await downloadAttachment(f, pick);
      const x = await extractText(d.body, { name: d.name, contentType: d.contentType });
      text += `\n\n[첨부 ${pick.name}]\n${x.text}`;
      note = `attachment ${pick.ext} (${x.method})`;
    }
    return { title: doc.title, text, note };
  }
  const limiter = openRateLimiter();
  try {
    const r = await fetchPage({ limiter }, url);
    if (!r.ok) throw new Error(r.reason ?? "fetch failed");
    if (r.pdf) {
      const x = await extractText(r.pdf, { name: "document.pdf", contentType: "application/pdf" });
      if (!x.ok) throw new Error(`PDF text not readable: ${x.error ?? x.method}`);
      return { title: "", text: x.text, note: `pdf (${x.method})` };
    }
    return { title: r.title, text: `${r.title}\n${r.text}`, note: null };
  } finally {
    limiter.close();
  }
}

export function retriever(deps: RetrieveDeps = {}) {
  return { search: deps.search ?? defaultSearch, fetch: deps.fetch ?? defaultFetch };
}
