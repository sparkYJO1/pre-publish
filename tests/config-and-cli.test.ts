import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertTermsFileOutsideRepo,
  ConfigError,
  parseConfig,
} from "../src/config.js";
import { main, parseArgs } from "../src/cli.js";
import { EXIT_FINDINGS, EXIT_UNTRUSTED, EXIT_USAGE } from "../src/report.js";
import { buildLeakyRepo, Fixture, TERMS } from "./fixture-repo.js";

class Capture {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

describe("terms files", () => {
  /**
   * The terms file is a list of the exact strings you are trying not to
   * publish. Storing it in the repository being published is the leak.
   */
  it("refuses a terms file stored inside the repository under audit", () => {
    expect(() =>
      assertTermsFileOutsideRepo("/repo/terms.json", "/repo"),
    ).toThrow(ConfigError);
    expect(() =>
      assertTermsFileOutsideRepo("/repo/a/b/terms.json", "/repo"),
    ).toThrow(ConfigError);
  });

  it("accepts one stored outside", () => {
    expect(() =>
      assertTermsFileOutsideRepo("/elsewhere/terms.json", "/repo"),
    ).not.toThrow();
  });

  it("refuses a suppression that repeats the sensitive string", () => {
    expect(() =>
      parseConfig({
        terms: [{ id: "client", value: "Norhaven" }],
        suppress: [{ termId: "client", value: "Norhaven", reason: "fine" }],
      }),
    ).toThrow(/never by value/);
  });

  it("requires a reason on every suppression", () => {
    expect(() =>
      parseConfig({
        terms: [{ id: "client", value: "Norhaven" }],
        suppress: [{ termId: "client" }],
      }),
    ).toThrow(/reason is required/);
  });

  it("accepts a bare string as a term", () => {
    const config = parseConfig({ terms: ["Norhaven"] });
    expect(config.terms[0]).toEqual({ id: "Norhaven", value: "Norhaven" });
  });

  it("rejects an unknown channel rather than silently scanning nothing", () => {
    expect(() =>
      parseConfig({ terms: [{ value: "x", channels: ["filenames"] }] }),
    ).toThrow(/valid channels are/);
  });
});

describe("argument parsing", () => {
  it("reads the flags it documents", () => {
    const args = parseArgs([
      "--repo",
      "/tmp/x",
      "--json",
      "--allow-shallow",
      "--no-secrets",
    ]);
    expect(args).toMatchObject({
      repo: "/tmp/x",
      json: true,
      allowShallow: true,
      secrets: false,
    });
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    expect(() => parseArgs(["--nope"])).toThrow(ConfigError);
  });
});

describe("the CLI end to end", () => {
  it("exits 1 with findings and prints a JSON report", () => {
    const fixture = buildLeakyRepo();
    const termsFile = join(fixture.dir, "..", `terms-${process.pid}.json`);
    try {
      writeFileSync(
        termsFile,
        JSON.stringify({ terms: [{ id: "product", value: TERMS.product }] }),
      );
      const out = new Capture();
      const err = new Capture();
      const code = main(
        ["--repo", fixture.dir, "--terms", termsFile, "--json"],
        out as never,
        err as never,
      );
      expect(code).toBe(EXIT_FINDINGS);
      const parsed = JSON.parse(out.text);
      expect(parsed.trusted).toBe(true);
      expect(parsed.findings.length).toBeGreaterThan(0);
      expect(parsed.exitCode).toBe(EXIT_FINDINGS);
    } finally {
      fixture.cleanup();
    }
  });

  it("exits 3 when the terms file sits inside the repository", () => {
    const fixture = buildLeakyRepo();
    try {
      const inside = join(fixture.dir, "terms.json");
      writeFileSync(inside, JSON.stringify({ terms: ["x"] }));
      const out = new Capture();
      const err = new Capture();
      const code = main(
        ["--repo", fixture.dir, "--terms", inside],
        out as never,
        err as never,
      );
      expect(code).toBe(EXIT_USAGE);
      expect(err.text).toMatch(/inside the repository/);
    } finally {
      fixture.cleanup();
    }
  });

  it("prints NOT TRUSTWORTHY before any finding count when the scan is untrusted", () => {
    const fixture = new Fixture().init();
    try {
      fixture.write("README.md", "# empty-ish\n");
      fixture.commit("init");
      const out = new Capture();
      const err = new Capture();
      const termsFile = join(
        fixture.dir,
        "..",
        `terms-untrusted-${process.pid}.json`,
      );
      writeFileSync(
        termsFile,
        JSON.stringify({
          terms: ["x"],
          controls: [
            { value: "not-present-anywhere-at-all", channel: "contents" },
          ],
        }),
      );
      const code = main(
        ["--repo", fixture.dir, "--terms", termsFile],
        out as never,
        err as never,
      );
      expect(code).toBe(EXIT_UNTRUSTED);
      expect(out.text).toMatch(/THIS RESULT IS NOT TRUSTWORTHY/);
      expect(out.text.indexOf("THIS RESULT IS NOT TRUSTWORTHY")).toBeLessThan(
        out.text.indexOf("FINDINGS ("),
      );
      expect(out.text).toMatch(/RESULT: NO-GO/);
    } finally {
      fixture.cleanup();
    }
  });
});
