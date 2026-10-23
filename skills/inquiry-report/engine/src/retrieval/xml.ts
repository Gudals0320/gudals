// Just enough XML handling for PubMed and PMC (JATS) records, without a
// parser package. These formats are regular and machine-generated, so tag
// matching by regular expression is reliable for the fields we read.

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Text content: tags removed, entities decoded, whitespace collapsed. */
export function textContent(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Inner XML of every non-nested <tag ...>...</tag>, with the opening tag's attributes. */
export function elements(xml: string, tag: string): { attrs: string; inner: string }[] {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => ({ attrs: m[1] ?? "", inner: m[2] }));
}

export function first(xml: string, tag: string): string | null {
  return elements(xml, tag)[0]?.inner ?? null;
}

export function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
}
