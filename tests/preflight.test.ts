import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RealGitRepo } from "../src/git.js";
import { isDenyAllIgnoreFile, preflight } from "../src/preflight.js";
import { scan } from "../src/scan.js";
import { exitCodeFor, EXIT_UNTRUSTED } from "../src/report.js";
import type { Config } from "../src/types.js";
import { buildLeakyRepo, Fixture, TERMS } from "./fixture-repo.js";

const config: Config = {
  terms: [{ id: "product", value: TERMS.product }],
  secrets: false,
};

describe("shallow clones", () => {
  /**
   * This reproduces the first failure of the real incident: a confidentiality
   * check that ran against a `--depth 1` clone, saw one commit of one branch,
   * and reported clean.
   */
  it("refuses to audit a shallow clone, because its history is not there", () => {
    const source = buildLeakyRepo();
    const workspace = mkdtempSync(join(tmpdir(), "pre-publish-shallow-"));
    try {
      execFileSync("git", [
        "clone",
        "-q",
        "--depth",
        "1",
        `file://${source.dir}`,
        join(workspace, "shallow"),
      ]);
      const shallow = new RealGitRepo(join(workspace, "shallow"));
      expect(shallow.isShallow()).toBe(true);

      // The shallow clone genuinely contains no trace of the term...
      const shallowReport = scan({ repo: shallow, config });
      expect(
        shallowReport.findings.filter((f) => f.channel === "contents"),
      ).toEqual([]);
      // ...so the tool must not let that zero be read as an answer.
      expect(shallowReport.trusted).toBe(false);
      expect(shallowReport.untrustedReasons.join(" ")).toMatch(/shallow/);
      expect(exitCodeFor(shallowReport)).toBe(EXIT_UNTRUSTED);

      // The full repository does contain it. Same tool, same terms.
      const fullReport = scan({ repo: new RealGitRepo(source.dir), config });
      expect(
        fullReport.findings.filter((f) => f.channel === "contents").length,
      ).toBeGreaterThan(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      source.cleanup();
    }
  });

  it("downgrades the blocker to a warning under --allow-shallow", () => {
    const source = buildLeakyRepo();
    const workspace = mkdtempSync(join(tmpdir(), "pre-publish-shallow-"));
    try {
      execFileSync("git", [
        "clone",
        "-q",
        "--depth",
        "1",
        `file://${source.dir}`,
        join(workspace, "shallow"),
      ]);
      const report = scan({
        repo: new RealGitRepo(join(workspace, "shallow")),
        config,
        allowShallow: true,
      });
      expect(report.warnings.map((w) => w.code)).toContain("shallow-clone");
      expect(report.untrustedReasons.join(" ")).not.toMatch(/shallow/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      source.cleanup();
    }
  });
});

describe("deny-all ignore files", () => {
  it("recognises the whitelist shape", () => {
    expect(isDenyAllIgnoreFile("*\n!allowed/\n!allowed/**\n")).toBe(true);
    expect(isDenyAllIgnoreFile("# comment\n\n/*\n!src\n")).toBe(true);
    expect(isDenyAllIgnoreFile("node_modules/\ndist/\n*.log\n")).toBe(false);
  });

  /**
   * The third failure of the real incident: the repository's `.gitignore`
   * ignored everything and re-allowed a handful of paths, and the scanner in
   * use honoured ignore files, so it skipped nearly every file and returned
   * zero. The tool cannot fix someone else's grep, but it can say out loud
   * that this repository is a trap for tools that honour ignore files.
   */
  it("warns when the audited repository uses one", () => {
    const fixture = new Fixture().init();
    try {
      fixture.write(".gitignore", "*\n!src/\n!src/**\n!.gitignore\n");
      fixture.write("src/app.ts", "export const app = 1;\n");
      fixture.commit("whitelist gitignore");
      const checks = preflight(new RealGitRepo(fixture.dir));
      expect(checks.warnings.map((w) => w.code)).toContain(
        "deny-all-ignore-file",
      );
      expect(checks.blockers).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("still reads ignored files, because it asks git for objects and not the filesystem", () => {
    const fixture = new Fixture().init();
    try {
      fixture.write(".gitignore", "*\n!.gitignore\n");
      fixture.write("secret-notes.md", `${TERMS.product} rollout plan\n`);
      // -f, because the whitelist would otherwise stop the add. The file is
      // now in history: a scanner that honours .gitignore will never see it.
      fixture.git(["add", "-f", ".gitignore", "secret-notes.md"]);
      fixture.git(["commit", "-q", "-m", "notes"]);

      const report = scan({ repo: new RealGitRepo(fixture.dir), config });
      const hits = report.findings.filter((f) => f.path === "secret-notes.md");
      expect(hits.length).toBeGreaterThan(0);
      expect(report.warnings.map((w) => w.code)).toContain(
        "deny-all-ignore-file",
      );
    } finally {
      fixture.cleanup();
    }
  });
});
