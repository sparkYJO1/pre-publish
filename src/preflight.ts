import type { GitRepo } from "./git.js";
import type { Warning } from "./types.js";

export interface Preflight {
  warnings: Warning[];
  /** Reasons the scan cannot be trusted no matter what it finds. */
  blockers: string[];
}

/**
 * A `.gitignore` whose first effective rule ignores everything, followed by
 * negations, is a whitelist. It is a normal thing to write and a hazard to
 * audit with: every tool that honours `.gitignore` -- ripgrep, ugrep with
 * `--ignore-files`, most editor search -- will silently skip almost the whole
 * repository and report a clean result.
 */
export function isDenyAllIgnoreFile(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const denyAll = new Set(["*", "/*", "**", "**/*", "*/"]);
  return lines.some((line) => denyAll.has(line));
}

export interface PreflightOptions {
  allowShallow?: boolean;
  /** Paths of ignore files to inspect, relative to the repo root. */
  ignoreFiles?: string[];
}

export function preflight(
  repo: GitRepo,
  options: PreflightOptions = {},
): Preflight {
  const warnings: Warning[] = [];
  const blockers: string[] = [];

  // 1. A shallow clone holds one commit. `git grep` over it is not a history
  //    check, however confidently it returns zero.
  if (repo.isShallow()) {
    const message =
      "this is a shallow clone; its history is truncated and a clean result here proves nothing";
    if (options.allowShallow) warnings.push({ code: "shallow-clone", message });
    else blockers.push(message);
  }

  // 2. A single-branch clone fetches one ref. Other branches are not on disk.
  const fetchSpecs = repo.remoteFetchSpecs();
  if (
    fetchSpecs.length > 0 &&
    !fetchSpecs.some((spec) => spec.includes("refs/heads/*"))
  ) {
    warnings.push({
      code: "single-branch-clone",
      message: `remote.origin.fetch is ${fetchSpecs.join(", ")}; branches outside that refspec were never fetched`,
    });
  }

  // 3. Deny-everything ignore files.
  const candidates = options.ignoreFiles ?? [".gitignore", ".git/info/exclude"];
  for (const path of candidates) {
    const text = repo.workingTreeFile(path);
    if (!text) continue;
    if (isDenyAllIgnoreFile(text)) {
      warnings.push({
        code: "deny-all-ignore-file",
        message: `${path} ignores everything and then re-allows specific paths; any scanner that honours ignore files will skip most of this repository and report it clean`,
      });
    }
  }

  return { warnings, blockers };
}
