/**
 * The five places a private repository leaks organisation-owned vocabulary.
 *
 * The incident this tool was written for leaked through `paths` (a directory
 * named after a product) and `identities` (an employer email address in the
 * author field). A content-only scanner sees neither.
 */
export type Channel =
  | "contents"
  | "paths"
  | "messages"
  | "identities"
  | "refs";

export const CHANNELS: readonly Channel[] = [
  "contents",
  "paths",
  "messages",
  "identities",
  "refs",
] as const;

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

/**
 * A term is a literal string, never a regular expression. Users supply
 * organisation, product and client names; asking them for regex would invite
 * both escaping bugs and terms that quietly match nothing.
 */
export interface TermSpec {
  id: string;
  value: string;
  /**
   * "auto" (default) applies ASCII word boundaries only when the term begins
   * and ends with an ASCII word character. Korean, Japanese and Chinese terms
   * therefore match as substrings, because `\b` is defined on [A-Za-z0-9_]
   * and would never fire next to a Hangul syllable.
   */
  wholeWord?: "auto" | "always" | "never";
  caseSensitive?: boolean;
  /** Restrict this term to some channels. Defaults to all five. */
  channels?: Channel[];
  note?: string;
}

/**
 * Suppressions reference a term by id, never by value. A suppression file that
 * repeated the sensitive string would be the leak it was written to prevent.
 */
export interface SuppressionSpec {
  termId: string;
  channel?: Channel;
  path?: string;
  pathPrefix?: string;
  reason: string;
}

/** A string the operator asserts is present, used to prove the scanner runs. */
export interface ControlSpec {
  value: string;
  channel: Channel;
  note?: string;
}

export interface Config {
  terms: TermSpec[];
  suppress?: SuppressionSpec[];
  controls?: ControlSpec[];
  /** Secret patterns are a secondary check; on by default, cheap to disable. */
  secrets?: boolean;
  /** Blobs larger than this are not read. Their paths are still scanned. */
  maxBlobBytes?: number;
}

export interface Finding {
  kind: "term" | "secret";
  id: string;
  channel: Channel;
  location: string;
  path?: string;
  line?: number;
  matches: number;
  /** Redacted unless --show-matches is passed. */
  sample?: string;
}

export interface Warning {
  code: string;
  message: string;
}

export interface ControlResult {
  value: string;
  channel: Channel;
  derived: boolean;
  matches: number;
  note?: string;
}

export interface ScanReport {
  repo: string;
  /**
   * False means: do not read the findings list as an answer. A zero from an
   * untrusted scan is the failure mode this whole tool exists to prevent.
   */
  trusted: boolean;
  untrustedReasons: string[];
  controls: ControlResult[];
  findings: Finding[];
  suppressed: { id: string; channel: Channel; location: string; reason: string }[];
  warnings: Warning[];
  stats: {
    commits: number;
    refs: number;
    paths: number;
    objects: number;
    blobsRead: number;
    bytesScanned: number;
  };
}
