import { buildCorpus } from "./corpus.js";
import type { Corpus, TextUnit } from "./corpus.js";
import { deriveControls, verifyControls } from "./controls.js";
import type { GitRepo } from "./git.js";
import { compileTerm, findMatches, redact } from "./matcher.js";
import { preflight } from "./preflight.js";
import { SECRET_PATTERNS } from "./secrets.js";
import { CHANNELS } from "./types.js";
import type { Config, Finding, ScanReport, SuppressionSpec } from "./types.js";

export interface ScanOptions {
  repo: GitRepo;
  config: Config;
  /** Scan a shallow clone anyway, downgrading the blocker to a warning. */
  allowShallow?: boolean;
  /** Print the matched text instead of a redaction placeholder. */
  showMatches?: boolean;
  maxBlobBytes?: number;
}

export function suppressionMatches(
  suppression: SuppressionSpec,
  finding: { id: string; channel: string; path?: string },
): boolean {
  if (suppression.termId !== finding.id) return false;
  if (suppression.channel && suppression.channel !== finding.channel)
    return false;
  if (suppression.path && suppression.path !== finding.path) return false;
  if (suppression.pathPrefix) {
    if (!finding.path || !finding.path.startsWith(suppression.pathPrefix))
      return false;
  }
  return true;
}

function unitsForChannels(
  corpus: Corpus,
  channels: readonly string[],
): TextUnit[] {
  return corpus.units.filter((unit) => channels.includes(unit.channel));
}

export function scan(options: ScanOptions): ScanReport {
  const { repo, config } = options;

  const checks = preflight(repo, {
    allowShallow: options.allowShallow ?? false,
  });

  const corpus = buildCorpus(repo, {
    ...((options.maxBlobBytes ?? config.maxBlobBytes)
      ? { maxBlobBytes: options.maxBlobBytes ?? config.maxBlobBytes! }
      : {}),
  });

  // --- controls first. Everything below is only meaningful if these pass. ---
  const derived = deriveControls(corpus);
  const verification = verifyControls(
    corpus,
    derived.controls,
    config.controls ?? [],
  );

  const untrustedReasons = [...checks.blockers, ...corpus.integrityProblems];
  for (const failure of verification.failures) {
    untrustedReasons.push(
      `control string for the ${failure.channel} channel matched 0 times; ` +
        `the scanner is not reading ${failure.channel}, so a clean result there means nothing`,
    );
  }
  for (const channel of derived.underivable) {
    untrustedReasons.push(
      `the ${channel} channel holds data but no control string could be derived from it; ` +
        `the scanner cannot prove it is reading ${channel}`,
    );
  }
  // No controls at all means nothing checked the scanner. "No findings" from a
  // scanner nobody checked is the exact sentence this tool exists to refuse.
  if (verification.results.length === 0) {
    untrustedReasons.push(
      "no control string could be established, so nothing verified that the scanner reads anything at all",
    );
  }
  // A channel with nothing in it cannot be verified, and in a repository that
  // plainly has data an empty channel means the scanner is not reading it.
  const repositoryHasData = corpus.stats.objects > 0 || corpus.stats.refs > 0;
  for (const channel of derived.empty) {
    if (!repositoryHasData) continue;
    untrustedReasons.push(
      `the ${channel} channel produced nothing to scan, in a repository with ` +
        `${corpus.stats.objects} objects and ${corpus.stats.refs} refs; ` +
        `the scanner cannot prove it is reading ${channel}`,
    );
  }

  // --- terms ---------------------------------------------------------------
  const findings: Finding[] = [];
  const suppressed: ScanReport["suppressed"] = [];
  const suppressions = config.suppress ?? [];

  const record = (finding: Finding) => {
    const hit = suppressions.find((s) => suppressionMatches(s, finding));
    if (hit) {
      suppressed.push({
        id: finding.id,
        channel: finding.channel,
        location: finding.location,
        reason: hit.reason,
      });
      return;
    }
    findings.push(finding);
  };

  for (const spec of config.terms) {
    const compiled = compileTerm(spec);
    const channels = spec.channels ?? CHANNELS;
    for (const unit of unitsForChannels(corpus, channels)) {
      const matches = findMatches(compiled.regex, unit.text);
      if (matches.length === 0) continue;
      const first = matches[0]!;
      record({
        kind: "term",
        id: spec.id,
        channel: unit.channel,
        location: unit.location,
        ...(unit.path ? { path: unit.path } : {}),
        ...(unit.channel === "contents" ? { line: first.line } : {}),
        matches: matches.length,
        sample: options.showMatches ? first.context : redact(first.context),
      });
    }
  }

  // --- secrets (secondary) --------------------------------------------------
  if (config.secrets !== false) {
    for (const pattern of SECRET_PATTERNS) {
      for (const unit of corpus.units) {
        const matches = findMatches(pattern.regex, unit.text);
        if (matches.length === 0) continue;
        const first = matches[0]!;
        record({
          kind: "secret",
          id: pattern.id,
          channel: unit.channel,
          location: unit.location,
          ...(unit.path ? { path: unit.path } : {}),
          ...(unit.channel === "contents" ? { line: first.line } : {}),
          matches: matches.length,
          // Never echo a credential, even with --show-matches.
          sample: redact(first.context),
        });
      }
    }
  }

  return {
    repo: repo.root,
    trusted: untrustedReasons.length === 0,
    untrustedReasons,
    controls: verification.results,
    findings,
    suppressed,
    warnings: [
      ...checks.warnings,
      ...corpus.warnings,
      ...verification.warnings,
    ],
    stats: corpus.stats,
  };
}
