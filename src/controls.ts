import type { Corpus, TextUnit } from "./corpus.js";
import { compileTerm, findMatches } from "./matcher.js";
import type { Channel, ControlSpec, ControlResult, Warning } from "./types.js";

/**
 * The rule this tool is built around: never report a zero from a scanner you
 * have not just watched find something.
 *
 * For each channel we take a string that provably exists in that channel --
 * a word from a real file, a real path segment, a word from a real commit
 * message, a real author address -- and push it through the same term pipeline
 * the audit uses. If any of those comes back with zero matches, the scanner is
 * not reading that channel and its "no findings" means nothing.
 */

const CONTROL_CHANNELS: Channel[] = [
  "contents",
  "paths",
  "messages",
  "identities",
  "refs",
];

function unitsFor(corpus: Corpus, channel: Channel): TextUnit[] {
  return corpus.units.filter((unit) => unit.channel === channel);
}

/** Longest ASCII word in a string, subject to a length window. */
function longestWord(text: string, min: number, max: number): string | null {
  const words = text.match(/[A-Za-z0-9_]{2,}/g);
  if (!words) return null;
  let best: string | null = null;
  for (const word of words) {
    if (word.length < min || word.length > max) continue;
    if (!best || word.length > best.length) best = word;
  }
  return best;
}

function deriveForContents(units: TextUnit[]): string | null {
  // Deterministic: sort by location so the same repo derives the same control.
  const sorted = [...units].sort((a, b) =>
    a.location.localeCompare(b.location),
  );
  for (const unit of sorted) {
    const word = longestWord(unit.text.slice(0, 200_000), 8, 40);
    if (word) return word;
  }
  return null;
}

function deriveForPaths(units: TextUnit[]): string | null {
  let best: string | null = null;
  for (const unit of units) {
    for (const segment of unit.text.split("/")) {
      const word = longestWord(segment, 3, 40);
      if (word && (!best || word.length > best.length)) best = word;
    }
  }
  return best;
}

function deriveForMessages(units: TextUnit[]): string | null {
  let best: string | null = null;
  for (const unit of units) {
    const word = longestWord(unit.text, 4, 40);
    if (word && (!best || word.length > best.length)) best = word;
  }
  return best;
}

function deriveForIdentities(units: TextUnit[]): string | null {
  for (const unit of units) {
    const email = unit.text.match(/<([^>\s]+)>/);
    if (email?.[1]) return email[1];
    const word = longestWord(unit.text, 3, 40);
    if (word) return word;
  }
  return null;
}

function deriveForRefs(units: TextUnit[]): string | null {
  let best: string | null = null;
  for (const unit of units) {
    for (const segment of unit.text.split("/")) {
      const word = longestWord(segment, 3, 40);
      if (word && (!best || word.length > best.length)) best = word;
    }
  }
  return best;
}

const DERIVERS: Record<Channel, (units: TextUnit[]) => string | null> = {
  contents: deriveForContents,
  paths: deriveForPaths,
  messages: deriveForMessages,
  identities: deriveForIdentities,
  refs: deriveForRefs,
};

export interface DerivedControls {
  controls: ControlSpec[];
  /** Channels that hold data but yielded no control: a hard problem. */
  underivable: Channel[];
  /** Channels that are simply empty in this repository. */
  empty: Channel[];
}

export function deriveControls(corpus: Corpus): DerivedControls {
  const controls: ControlSpec[] = [];
  const underivable: Channel[] = [];
  const empty: Channel[] = [];

  for (const channel of CONTROL_CHANNELS) {
    const units = unitsFor(corpus, channel);
    if (units.length === 0) {
      empty.push(channel);
      continue;
    }
    const value = DERIVERS[channel](units);
    if (!value) {
      underivable.push(channel);
      continue;
    }
    controls.push({
      value,
      channel,
      note: `derived from this repository's own ${channel}`,
    });
  }

  return { controls, underivable, empty };
}

export interface ControlVerification {
  results: ControlResult[];
  failures: ControlResult[];
  warnings: Warning[];
}

export function verifyControls(
  corpus: Corpus,
  derived: ControlSpec[],
  supplied: ControlSpec[] = [],
): ControlVerification {
  const results: ControlResult[] = [];
  const failures: ControlResult[] = [];
  const warnings: Warning[] = [];

  const all: { spec: ControlSpec; derived: boolean }[] = [
    ...derived.map((spec) => ({ spec, derived: true })),
    ...supplied.map((spec) => ({ spec, derived: false })),
  ];

  for (const { spec, derived: isDerived } of all) {
    // Same compile path, same match path as a real term. A control that took a
    // shortcut around the matcher would verify nothing.
    const compiled = compileTerm({
      id: `control:${spec.channel}`,
      value: spec.value,
      caseSensitive: true,
    });
    let matches = 0;
    for (const unit of corpus.units) {
      if (unit.channel !== spec.channel) continue;
      matches += findMatches(compiled.regex, unit.text).length;
      if (matches > 0 && isDerived) break; // one hit is proof enough
    }
    const result: ControlResult = {
      value: spec.value,
      channel: spec.channel,
      derived: isDerived,
      matches,
      ...(spec.note ? { note: spec.note } : {}),
    };
    results.push(result);
    if (matches === 0) failures.push(result);
  }

  if (results.length === 0) {
    warnings.push({
      code: "no-controls",
      message:
        "no control strings could be established; nothing verified the scanner",
    });
  }

  return { results, failures, warnings };
}
