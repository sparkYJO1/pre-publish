#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTermsFileOutsideRepo,
  ConfigError,
  EMPTY_CONFIG,
  loadConfig,
} from "./config.js";
import { GitError, RealGitRepo } from "./git.js";
import { exitCodeFor, formatJson, formatReport, EXIT_USAGE } from "./report.js";
import { scan } from "./scan.js";

const USAGE = `pre-publish -- audit a repository's entire history before open-sourcing it

  pre-publish [options]

Options
  --repo <path>            repository to audit (default: .)
  --terms <file.json>      terms, suppressions and controls (see README)
  --json                   machine-readable report on stdout
  --show-matches           print matched text instead of a redaction placeholder
                           (never applies to secret matches)
  --allow-shallow          scan a shallow clone anyway, as a warning not a blocker
  --allow-terms-in-repo    permit a terms file stored inside the audited repo
  --no-reflog              scan refs only, ignoring the reflog
  --no-secrets             skip the secondary credential patterns
  --max-blob-bytes <n>     do not read blobs larger than this (default 2097152)
  -h, --help               this text

Exit codes
  0  go        controls verified, no findings
  1  no-go     findings
  2  no-go     the scan could not be trusted; the number it printed means nothing
  3  usage error
`;

export interface CliArgs {
  repo: string;
  terms?: string;
  json: boolean;
  showMatches: boolean;
  allowShallow: boolean;
  allowTermsInRepo: boolean;
  reflog: boolean;
  secrets: boolean;
  maxBlobBytes?: number;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    repo: ".",
    json: false,
    showMatches: false,
    allowShallow: false,
    allowTermsInRepo: false,
    reflog: true,
    secrets: true,
    help: false,
  };
  const need = (flag: string, value: string | undefined): string => {
    if (value === undefined) throw new ConfigError(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case "--repo":
        args.repo = need(flag, argv[++i]);
        break;
      case "--terms":
        args.terms = need(flag, argv[++i]);
        break;
      case "--json":
        args.json = true;
        break;
      case "--show-matches":
        args.showMatches = true;
        break;
      case "--allow-shallow":
        args.allowShallow = true;
        break;
      case "--allow-terms-in-repo":
        args.allowTermsInRepo = true;
        break;
      case "--no-reflog":
        args.reflog = false;
        break;
      case "--no-secrets":
        args.secrets = false;
        break;
      case "--max-blob-bytes":
        args.maxBlobBytes = Number(need(flag, argv[++i]));
        if (!Number.isFinite(args.maxBlobBytes) || args.maxBlobBytes <= 0) {
          throw new ConfigError("--max-blob-bytes must be a positive number");
        }
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new ConfigError(`unknown option ${flag}`);
    }
  }
  return args;
}

export function main(
  argv: string[],
  out = process.stdout,
  err = process.stderr,
): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    err.write(`${(error as Error).message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (args.help) {
    out.write(USAGE);
    return 0;
  }

  const repoRoot = resolve(args.repo);
  try {
    let config = EMPTY_CONFIG;
    if (args.terms) {
      if (!args.allowTermsInRepo)
        assertTermsFileOutsideRepo(args.terms, repoRoot);
      config = loadConfig(args.terms);
    }
    if (!args.secrets) config = { ...config, secrets: false };

    const repo = new RealGitRepo(repoRoot, { includeReflog: args.reflog });
    const report = scan({
      repo,
      config,
      allowShallow: args.allowShallow,
      showMatches: args.showMatches,
      ...(args.maxBlobBytes ? { maxBlobBytes: args.maxBlobBytes } : {}),
    });
    out.write(args.json ? formatJson(report) : formatReport(report));
    return exitCodeFor(report);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof GitError) {
      err.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
