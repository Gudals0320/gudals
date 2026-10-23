// Small, dependency-free HTML helpers for the Korean government boards. The
// pages are server-rendered with stable class names, so a few regular
// expressions are enough. Page text is untrusted data: it is only ever
// turned into plain text, never interpreted.

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", bull: "•", times: "×", sim: "∼", reg: "®", copy: "©",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Plain text of an HTML fragment: block ends become line breaks, runs of blank space collapse. */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|dd|dt)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s)
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n")
    .trim();
}

/** Inner HTML of the first element whose opening tag matches `open`, balancing nested tags of the same name. */
export function sliceElement(html: string, open: RegExp): string | null {
  const m = open.exec(html);
  if (!m) return null;
  const tag = m[0].match(/^<([a-z0-9]+)/i)?.[1]?.toLowerCase();
  if (!tag) return null;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = m.index + m[0].length;
  let depth = 1;
  for (let t = re.exec(html); t; t = re.exec(html)) {
    if (t[0].endsWith("/>")) continue;
    depth += t[1] ? -1 : 1;
    if (depth === 0) return html.slice(m.index + m[0].length, t.index);
  }
  return html.slice(m.index + m[0].length);
}

export function absUrl(href: string, base: string): string {
  return new URL(decodeEntities(href), base).toString();
}

/** "2026.10.14", "2026-10-14" or "2026. 10. 14." as ISO date, else null. */
export function isoDate(s: string): string | null {
  const m = s.match(/(20\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

export function extOf(name: string): string {
  const m = name.trim().toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return m ? m[1] : "";
}
