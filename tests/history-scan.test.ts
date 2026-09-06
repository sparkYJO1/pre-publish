import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealGitRepo } from "../src/git.js";
import { scan } from "../src/scan.js";
import { exitCodeFor, EXIT_FINDINGS } from "../src/report.js";
import type { Config, Finding } from "../src/types.js";
import { buildLeakyRepo, Fixture, TERMS } from "./fixture-repo.js";

const config: Config = {
  terms: [
    { id: "product", value: TERMS.product },
    { id: "client", value: TERMS.client },
    { id: "client-ko", value: TERMS.clientKorean },
    { id: "employer-domain", value: TERMS.employerDomain },
  ],
  secrets: true,
};

function findingsFor(
  findings: Finding[],
  id: string,
  channel: string,
): Finding[] {
  return findings.filter((f) => f.id === id && f.channel === channel);
}

describe("scanning a repository whose working tree is clean and history is not", () => {
  let fixture: Fixture;
  let report: ReturnType<typeof scan>;

  beforeAll(() => {
    fixture = buildLeakyRepo();
    report = scan({ repo: new RealGitRepo(fixture.dir), config });
  });

  afterAll(() => fixture.cleanup());

  it("trusts the scan: every control string matched", () => {
    expect(report.untrustedReasons).toEqual([]);
    expect(report.trusted).toBe(true);
    expect(report.controls.length).toBeGreaterThan(0);
    for (const control of report.controls) {
      expect(control.matches, `control for ${control.channel}`).toBeGreaterThan(
        0,
      );
    }
  });

  it("finds a term in a file that was deleted before publishing", () => {
    const hits = findingsFor(report.findings, "product", "contents");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.path === "src/gateway.ts")).toBe(true);
  });

  it("finds a term in a directory name, which no content scanner sees", () => {
    const hits = findingsFor(report.findings, "client", "paths");
    expect(hits.map((h) => h.location)).toContain(
      `vendor/${TERMS.client}/adapter.ts`,
    );
  });

  it("finds a term in a commit message", () => {
    expect(
      findingsFor(report.findings, "product", "messages").length,
    ).toBeGreaterThan(0);
  });

  it("finds an employer address in the author identity", () => {
    const hits = findingsFor(report.findings, "employer-domain", "identities");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("finds a term in a branch name", () => {
    const hits = findingsFor(report.findings, "product", "refs");
    expect(hits.map((h) => h.location)).toContain(
      `refs/heads/legacy/${TERMS.product}-migration`,
    );
  });

  it("finds a non-ASCII term that an ASCII word-boundary regex would miss", () => {
    const hits = findingsFor(report.findings, "client-ko", "contents");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe("docs/notes.md");
  });

  it("finds a term on a branch that is not checked out", () => {
    const onBranch = report.findings.filter(
      (f) => f.path === `vendor/${TERMS.client}/adapter.ts`,
    );
    expect(onBranch.length).toBeGreaterThan(0);
  });

  it("reports a credential pattern as a secondary finding", () => {
    const secrets = report.findings.filter((f) => f.kind === "secret");
    expect(secrets.map((s) => s.id)).toContain("aws-access-key-id");
  });

  it("never echoes a secret, and redacts term matches by default", () => {
    for (const finding of report.findings) {
      expect(finding.sample ?? "").not.toContain(TERMS.exampleAwsKey);
      if (finding.kind === "term") {
        expect(finding.sample ?? "").toMatch(/redacted/);
      }
    }
  });

  it("exits non-zero so it can gate CI", () => {
    expect(exitCodeFor(report)).toBe(EXIT_FINDINGS);
  });
});

describe("--show-matches", () => {
  it("reveals term context but still withholds secrets", () => {
    const fixture = buildLeakyRepo();
    try {
      const report = scan({
        repo: new RealGitRepo(fixture.dir),
        config,
        showMatches: true,
      });
      const term = report.findings.find(
        (f) => f.kind === "term" && f.channel === "contents",
      );
      expect(term?.sample).toContain(TERMS.product);
      for (const secret of report.findings.filter((f) => f.kind === "secret")) {
        expect(secret.sample ?? "").not.toContain(TERMS.exampleAwsKey);
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe("a repository with nothing to find", () => {
  it("returns go, but only after the controls have matched", () => {
    const fixture = new Fixture().init();
    try {
      fixture.write(
        "README.md",
        "# unrelated project\n\nNothing of interest here.\n",
      );
      fixture.commit("initial commit");
      const report = scan({ repo: new RealGitRepo(fixture.dir), config });
      expect(report.findings).toEqual([]);
      expect(report.trusted).toBe(true);
      expect(exitCodeFor(report)).toBe(0);
      // The zero is only meaningful because these matched.
      const channels = report.controls
        .filter((c) => c.matches > 0)
        .map((c) => c.channel);
      expect(channels).toContain("contents");
      expect(channels).toContain("paths");
      expect(channels).toContain("messages");
      expect(channels).toContain("identities");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("suppressions", () => {
  it("moves a finding out of the findings list and records the stated reason", () => {
    const fixture = buildLeakyRepo();
    try {
      const report = scan({
        repo: new RealGitRepo(fixture.dir),
        config: {
          ...config,
          suppress: [
            {
              termId: "client",
              channel: "paths",
              pathPrefix: "vendor/",
              reason: "vendored third-party directory, name is public",
            },
          ],
        },
      });
      expect(findingsFor(report.findings, "client", "paths")).toEqual([]);
      expect(report.suppressed.map((s) => s.reason)).toContain(
        "vendored third-party directory, name is public",
      );
    } finally {
      fixture.cleanup();
    }
  });
});
