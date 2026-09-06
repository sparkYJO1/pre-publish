import { describe, expect, it } from "vitest";
import { RealGitRepo } from "../src/git.js";
import type { GitRepo } from "../src/git.js";
import { scan } from "../src/scan.js";
import { exitCodeFor, EXIT_UNTRUSTED } from "../src/report.js";
import type { Config } from "../src/types.js";
import { buildLeakyRepo, Fixture, TERMS } from "./fixture-repo.js";

const config: Config = {
  terms: [{ id: "product", value: TERMS.product }],
  secrets: false,
};

/**
 * The failure being reproduced: a scanner that reads none of the file contents
 * and reports zero findings. In the real incident the cause was a `grep` shell
 * function that shimmed ugrep with `--ignore-files`, so a deny-all `.gitignore`
 * made it skip almost every file. The mechanism does not matter. What matters
 * is that the tool must not answer "clean" when it read nothing.
 */
function withBlindContentReads(repo: GitRepo): GitRepo {
  return {
    root: repo.root,
    isShallow: () => repo.isShallow(),
    refNames: () => repo.refNames(),
    commits: () => repo.commits(),
    paths: () => repo.paths(),
    objects: () => repo.objects(),
    // Silently returns nothing, the way the shimmed grep silently skipped files.
    readObjects: () => new Map(),
    workingTreeFile: (path) => repo.workingTreeFile(path),
    remoteFetchSpecs: () => repo.remoteFetchSpecs(),
  };
}

/** A scanner that reads contents but never enumerates commit identities. */
function withBlindIdentities(repo: GitRepo): GitRepo {
  return { ...withPassthrough(repo), commits: () => [] };
}

function withPassthrough(repo: GitRepo): GitRepo {
  return {
    root: repo.root,
    isShallow: () => repo.isShallow(),
    refNames: () => repo.refNames(),
    commits: () => repo.commits(),
    paths: () => repo.paths(),
    objects: () => repo.objects(),
    readObjects: (shas) => repo.readObjects(shas),
    workingTreeFile: (path) => repo.workingTreeFile(path),
    remoteFetchSpecs: () => repo.remoteFetchSpecs(),
  };
}

describe("control-string verification", () => {
  it("refuses to report a clean scan when the content reader returns nothing", () => {
    const fixture = buildLeakyRepo();
    try {
      const real = new RealGitRepo(fixture.dir);
      const broken = withBlindContentReads(real);

      const report = scan({ repo: broken, config });

      // The scan found no term in file contents...
      expect(report.findings.filter((f) => f.channel === "contents")).toEqual(
        [],
      );
      // ...and says so loudly rather than calling the repository clean.
      expect(report.trusted).toBe(false);
      expect(report.untrustedReasons.join("\n")).toMatch(/contents/);
      expect(exitCodeFor(report)).toBe(EXIT_UNTRUSTED);
    } finally {
      fixture.cleanup();
    }
  });

  it("names the missing objects rather than scanning what is left", () => {
    const fixture = buildLeakyRepo();
    try {
      const report = scan({
        repo: withBlindContentReads(new RealGitRepo(fixture.dir)),
        config,
      });
      expect(report.untrustedReasons.join("\n")).toMatch(
        /listed by git but returned no content/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("catches a channel that was silently dropped, not just a broken reader", () => {
    const fixture = buildLeakyRepo();
    try {
      const report = scan({
        repo: withBlindIdentities(new RealGitRepo(fixture.dir)),
        config,
      });
      expect(report.trusted).toBe(false);
      // No commits means no identities and no messages to verify against.
      expect(report.controls.some((c) => c.channel === "identities")).toBe(
        false,
      );
      expect(report.untrustedReasons.length).toBeGreaterThan(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails when an operator-supplied control does not match", () => {
    const fixture = buildLeakyRepo();
    try {
      const report = scan({
        repo: new RealGitRepo(fixture.dir),
        config: {
          ...config,
          controls: [
            {
              value: "a-string-that-is-definitely-not-in-this-repository",
              channel: "contents",
              note: "deliberately wrong",
            },
          ],
        },
      });
      expect(report.trusted).toBe(false);
      expect(report.controls.find((c) => !c.derived)?.matches).toBe(0);
      expect(exitCodeFor(report)).toBe(EXIT_UNTRUSTED);
    } finally {
      fixture.cleanup();
    }
  });

  it("passes when an operator-supplied control is genuinely present", () => {
    const fixture = buildLeakyRepo();
    try {
      const report = scan({
        repo: new RealGitRepo(fixture.dir),
        config: {
          ...config,
          controls: [{ value: TERMS.clientKorean, channel: "contents" }],
        },
      });
      const supplied = report.controls.find((c) => !c.derived);
      expect(supplied?.matches).toBeGreaterThan(0);
      // A non-ASCII control also proves the matcher handles non-ASCII input.
      expect(report.untrustedReasons).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("a repository with no commits", () => {
  /**
   * Found by pointing the tool at its own repository before the first commit.
   * It printed "RESULT: GO -- controls verified and no findings" having
   * verified nothing at all: the exact sentence this tool exists to refuse.
   */
  it("is untrusted, not clean", () => {
    const fixture = new Fixture().init();
    try {
      const report = scan({ repo: new RealGitRepo(fixture.dir), config });
      expect(report.controls).toEqual([]);
      expect(report.findings).toEqual([]);
      expect(report.trusted).toBe(false);
      expect(report.untrustedReasons.join(" ")).toMatch(/nothing verified/);
      expect(exitCodeFor(report)).toBe(EXIT_UNTRUSTED);
    } finally {
      fixture.cleanup();
    }
  });
});
