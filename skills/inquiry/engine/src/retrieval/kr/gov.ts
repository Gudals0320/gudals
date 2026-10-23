// Korean official boards: 대한민국 정책브리핑 (korea.kr) press releases, which
// mirror every ministry and agency, and the 질병관리청 (kdca.go.kr) press
// release board. Both robots.txt files allow these list and view pages
// (korea.kr only bars Googlebot from totalSearch.do; kdca only /search.do).
// Search uses the boards' own GET list URLs. Bodies on korea.kr are rendered
// in a document-viewer iframe, so the full text there comes from the
// attachments (HWPX/HWP/PDF); the list page carries a long lead.

import { absUrl, decodeEntities, extOf, htmlToText, isoDate, sliceElement } from "./html.ts";
import { assertNotBlocked, type KrFetch } from "./http.ts";

export type GovSource = "korea_kr" | "kdca";

export type GovListItem = {
  source: GovSource;
  title: string;
  url: string;
  date: string | null;
  /** Ministry or agency on korea.kr, department on kdca. */
  agency: string | null;
  lead: string | null;
  has_attachment: boolean | null;
};

export type GovAttachment = { name: string; url: string; ext: string };

export type GovDoc = {
  source: GovSource;
  url: string;
  title: string;
  date: string | null;
  agency: string | null;
  department: string | null;
  /** HTML body as text; empty when the site shows the body only through a viewer. */
  body_text: string;
  attachments: GovAttachment[];
};

export type GovSearchResult = { source: GovSource; query: string; url: string; total: number | null; items: GovListItem[] };

// ---------- korea.kr ----------

export const KOREA_KR = "https://www.korea.kr";

export function koreaKrSearchUrl(query: string, opts: { startDate?: string; endDate?: string; page?: number } = {}): string {
  const u = new URL("/briefing/pressReleaseList.do", KOREA_KR);
  u.searchParams.set("srchWord", query);
  if (opts.startDate) u.searchParams.set("startDate", opts.startDate);
  if (opts.endDate) u.searchParams.set("endDate", opts.endDate);
  u.searchParams.set("pageIndex", String(opts.page ?? 1));
  return u.toString();
}

/** Strips the query string down to newsId, so the same release has one URL. */
export function koreaKrViewUrl(href: string): string {
  const u = new URL(decodeEntities(href), KOREA_KR);
  const id = u.searchParams.get("newsId");
  return id ? `${KOREA_KR}/briefing/pressReleaseView.do?newsId=${id}` : u.toString();
}

export function parseKoreaKrList(html: string): { total: number | null; items: GovListItem[] } {
  const list = sliceElement(html, /<div class="list_type"[^>]*>/) ?? "";
  const items: GovListItem[] = [];
  for (const m of list.matchAll(/<li>\s*<a href="([^"]*pressReleaseView\.do[^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/g)) {
    const inner = m[2];
    const title = htmlToText(inner.match(/<strong>([\s\S]*?)<\/strong>/)?.[1] ?? "");
    // Search hits are wrapped in <span class="highlight">, so the lead needs balanced slicing.
    const lead = htmlToText(sliceElement(inner, /<span class="lead">/) ?? "");
    const src = sliceElement(inner, /<span class="source">/) ?? "";
    const spans = [...src.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((s) => htmlToText(s[1]));
    items.push({
      source: "korea_kr",
      title,
      url: koreaKrViewUrl(m[1]),
      date: spans.map(isoDate).find(Boolean) ?? null,
      agency: spans.find((s) => !isoDate(s)) ?? null,
      lead: lead || null,
      has_attachment: null,
    });
  }
  const total = html.match(/검색결과 총\s*<strong>([\d,]+)<\/strong>/)?.[1];
  return { total: total ? Number(total.replace(/,/g, "")) : null, items };
}

export function parseKoreaKrView(html: string, url: string): GovDoc {
  const title = htmlToText(html.match(/<div class="view_title">\s*<h1>([\s\S]*?)<\/h1>/)?.[1] ?? html.match(/<title>([^<]*?)(?: - [^<]*)?<\/title>/)?.[1] ?? "");
  const info = sliceElement(html, /<div class="info">/) ?? "";
  const date = isoDate(htmlToText(info));
  const remark = htmlToText(html.match(/<p class="remark">([\s\S]*?)<\/p>/)?.[1] ?? "");
  const agency = remark.match(/이 자료는\s*(.+?)의 보도자료를/)?.[1]?.trim() ?? null;
  const files = sliceElement(html, /<div class="filedown">/) ?? "";
  const attachments: GovAttachment[] = [];
  const seen = new Set<string>();
  for (const m of files.matchAll(/<a href="([^"]*download\.do[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const name = htmlToText(m[2]);
    if (!name || name === "내려받기" || name === "바로보기") continue;
    const u = absUrl(m[1], KOREA_KR);
    if (seen.has(u)) continue;
    seen.add(u);
    attachments.push({ name, url: u, ext: extOf(name) });
  }
  const body = sliceElement(html, /<div class="view_cont">/) ?? "";
  return { source: "korea_kr", url, title, date, agency, department: null, body_text: htmlToText(body).replace(remark, "").trim(), attachments };
}

// ---------- kdca.go.kr ----------

export const KDCA = "https://www.kdca.go.kr";
/** 보도자료(전체) board. */
export const KDCA_PRESS_BOARD = "41";

export function kdcaSearchUrl(query: string, opts: { page?: number; field?: "sj" | "deptNm"; board?: string } = {}): string {
  const u = new URL(`/bbs/kdca/${opts.board ?? KDCA_PRESS_BOARD}/artclList.do`, KDCA);
  u.searchParams.set("findType", opts.field ?? "sj");
  u.searchParams.set("findWord", query);
  u.searchParams.set("page", String(opts.page ?? 1));
  return u.toString();
}

export const kdcaViewUrl = (board: string, id: string) => `${KDCA}/bbs/kdca/${board}/${id}/artclView.do`;

export function parseKdcaList(html: string): { total: number | null; items: GovListItem[] } {
  const body = sliceElement(html, /<tbody[^>]*>/) ?? "";
  const items: GovListItem[] = [];
  for (const row of body.split(/<tr\b[^>]*>/).slice(1)) {
    const v = row.match(/jf_viewArtcl\('kdca',\s*'(\d+)',\s*'(\d+)'\)/);
    if (!v) continue;
    const titleCell = sliceElement(row, /<td class="td-title[^"]*"[^>]*>/) ?? "";
    const title = htmlToText(titleCell.match(/<strong>([\s\S]*?)<\/strong>/)?.[1] ?? titleCell).replace(/\s*새글$/, "");
    items.push({
      source: "kdca",
      title,
      url: kdcaViewUrl(v[1], v[2]),
      date: isoDate(row.match(/<td class="td-date">([^<]*)<\/td>/)?.[1] ?? ""),
      agency: htmlToText(row.match(/<td class="td-write">([\s\S]*?)<\/td>/)?.[1] ?? "") || null,
      lead: null,
      has_attachment: /<td class="td-file">\s*<img/.test(row),
    });
  }
  const total = html.match(/총\s*<strong>([\d,]+)<\/strong>\s*개의 게시물/)?.[1];
  return { total: total ? Number(total.replace(/,/g, "")) : null, items };
}

export function parseKdcaView(html: string, url: string): GovDoc {
  const view = sliceElement(html, /<div class="view viewCont">/) ?? html;
  const title = htmlToText(view.match(/<div class="title">\s*<strong>([\s\S]*?)<\/strong>/)?.[1] ?? "")
    || decodeEntities(html.match(/id="artclViewTitle" value="([^"]*)"/)?.[1] ?? "");
  const detail = view.match(/<ul class="detail">([\s\S]*?)<\/ul>/)?.[1] ?? "";
  const field = (label: string) => {
    const m = detail.match(new RegExp(`<span>${label}</span>([\\s\\S]*?)</li>`));
    return m ? htmlToText(m[1]) || null : null;
  };
  const txt = sliceElement(view, /<div class="txt">/) ?? "";
  const attachBlock = sliceElement(txt, /<div class="attachment">/) ?? "";
  const bodyHtml = attachBlock ? txt.replace(attachBlock, "") : txt;
  const attachments: GovAttachment[] = [];
  for (const li of attachBlock.split(/<li\b[^>]*>/).slice(1)) {
    const href = li.match(/<a class="attch-down"[^>]*href="([^"]+)"/)?.[1];
    if (!href) continue;
    const name = htmlToText(li.replace(/<div>[\s\S]*$/, ""));
    attachments.push({ name, url: absUrl(href, KDCA), ext: extOf(name) });
  }
  return {
    source: "kdca",
    url,
    title,
    date: isoDate(field("작성일") ?? ""),
    agency: "질병관리청",
    department: field("담당부서"),
    body_text: htmlToText(bodyHtml),
    attachments,
  };
}

// ---------- fetch wrappers ----------

const html = (b: Buffer) => b.toString("utf8");

export async function searchKoreaKr(fetchFn: KrFetch, query: string, opts: Parameters<typeof koreaKrSearchUrl>[1] = {}): Promise<GovSearchResult> {
  const url = koreaKrSearchUrl(query, opts);
  const res = assertNotBlocked(await fetchFn(url));
  if (!res.ok) throw new Error(`korea.kr list HTTP ${res.status}`);
  return { source: "korea_kr", query, url, ...parseKoreaKrList(html(res.body)) };
}

export async function searchKdca(fetchFn: KrFetch, query: string, opts: Parameters<typeof kdcaSearchUrl>[1] = {}): Promise<GovSearchResult> {
  const url = kdcaSearchUrl(query, opts);
  const res = assertNotBlocked(await fetchFn(url));
  if (!res.ok) throw new Error(`kdca list HTTP ${res.status}`);
  return { source: "kdca", query, url, ...parseKdcaList(html(res.body)) };
}

export async function fetchGovDoc(fetchFn: KrFetch, item: Pick<GovListItem, "source" | "url">): Promise<GovDoc> {
  const res = assertNotBlocked(await fetchFn(item.url));
  if (!res.ok) throw new Error(`${item.source} view HTTP ${res.status}`);
  return item.source === "korea_kr" ? parseKoreaKrView(html(res.body), item.url) : parseKdcaView(html(res.body), item.url);
}

export type DownloadedFile = { url: string; name: string; contentType: string; body: Buffer };

/** Downloads one attachment. The body is untrusted data: it is only parsed for text, never opened or run. */
export async function downloadAttachment(fetchFn: KrFetch, a: GovAttachment): Promise<DownloadedFile> {
  const res = assertNotBlocked(await fetchFn(a.url));
  if (!res.ok) throw new Error(`attachment HTTP ${res.status}`);
  return { url: a.url, name: a.name, contentType: res.contentType, body: res.body };
}
