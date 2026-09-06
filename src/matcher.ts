import type { TermSpec } from "./types.js";

export interface Match {
  index: number;
  line: number;
  /** The matched text plus a little surrounding context. Redact before printing. */
  context: string;
}

export interface CompiledTerm {
  spec: TermSpec;
  regex: RegExp;
  wholeWord: boolean;
}

/**
 * Terms are literals, so every regex metacharacter is escaped. The `u` flag is
 * deliberately not used: under `u`, an escaped non-syntax character is a syntax
 * error, which would make escaping user input harder rather than safer. Hangul,
 * Kana and Han are all in the BMP, so UTF-16 matching is exact for them.
 */
export function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `\b` is defined against [A-Za-z0-9_]. Wrapping a Hangul term in `\b` asserts
 * a word character sits next to it, so the term matches only by accident.
 * Boundaries are therefore applied only when the term's own first and last
 * characters are ASCII word characters.
 */
export function shouldUseWordBoundary(spec: TermSpec): boolean {
  if (spec.wholeWord === "always") return true;
  if (spec.wholeWord === "never") return false;
  const first = spec.value.at(0);
  const last = spec.value.at(-1);
  const wordy = /^[A-Za-z0-9_]$/;
  return Boolean(first && last && wordy.test(first) && wordy.test(last));
}

export function compileTerm(spec: TermSpec): CompiledTerm {
  if (spec.value.length === 0) {
    throw new Error(`term "${spec.id}" has an empty value`);
  }
  const wholeWord = shouldUseWordBoundary(spec);
  const body = escapeLiteral(spec.value);
  const source = wholeWord ? `\\b${body}\\b` : body;
  const flags = spec.caseSensitive ? "g" : "gi";
  return { spec, regex: new RegExp(source, flags), wholeWord };
}

const MAX_MATCHES_PER_UNIT = 200;

export function findMatches(regex: RegExp, text: string): Match[] {
  const matches: Match[] = [];
  const search = new RegExp(
    regex.source,
    regex.flags.includes("g") ? regex.flags : regex.flags + "g",
  );
  search.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = search.exec(text)) !== null) {
    matches.push({
      index: hit.index,
      line: lineNumberAt(text, hit.index),
      context: contextAt(text, hit.index, hit[0].length),
    });
    if (hit[0].length === 0) search.lastIndex += 1;
    if (matches.length >= MAX_MATCHES_PER_UNIT) break;
  }
  return matches;
}

export function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function contextAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + length + 24);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Reports name the term and its location; they do not repeat the secret. A
 * report pasted into a CI log or a ticket must not become the leak.
 */
export function redact(context: string): string {
  return `<${context.length} chars, redacted; rerun with --show-matches>`;
}
