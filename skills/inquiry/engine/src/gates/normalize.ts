// Text normalization for quote matching against archived copies.
// PDF and DOM extraction break lines mid-word, swap quote styles and dashes,
// and vary whitespace; none of that should make a faithful quote fail.
// Digits and signs are kept as they are: a quote must still copy numbers exactly.

export type HyphenBreak = "join" | "keep";

const QUOTES: [RegExp, string][] = [
  [/[‘’‚‛′`´]/g, "'"],
  [/[“”„‟″«»]/g, '"'],
  [/[‐‑‒–—―−﹘﹣－]/g, "-"],
];

/**
 * Normalize text for containment checks.
 * "join" (default) turns "evi-\ndence" into "evidence"; "keep" turns
 * "long-\nterm" into "long-term". Line-end hyphens after digits are always kept.
 */
export function normalizeForMatch(text: string, hyphenBreak: HyphenBreak = "join"): string {
  let s = text.normalize("NFKC").replace(/[­​-‍⁠﻿]/g, "");
  for (const [re, to] of QUOTES) s = s.replace(re, to);
  if (hyphenBreak === "join") s = s.replace(/(\p{L})-[ \t]*\r?\n\s*(?=\p{L})/gu, "$1");
  s = s.replace(/-[ \t]*\r?\n\s*/g, "-");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when the quote appears in the text after normalization. A line-end
 * hyphen can be a word split or a real compound, so both readings are tried.
 */
export function quoteInText(quote: string, text: string): boolean {
  const q = normalizeForMatch(quote, "keep");
  if (!q) return false;
  return normalizeForMatch(text, "join").includes(q) || normalizeForMatch(text, "keep").includes(q);
}
