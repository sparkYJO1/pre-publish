import { describe, expect, it } from "vitest";
import {
  compileTerm,
  escapeLiteral,
  findMatches,
  shouldUseWordBoundary,
} from "../src/matcher.js";

describe("word boundaries", () => {
  it("applies ASCII boundaries to an ASCII term", () => {
    expect(shouldUseWordBoundary({ id: "a", value: "Zephyr" })).toBe(true);
    const term = compileTerm({ id: "a", value: "Zephyr" });
    expect(findMatches(term.regex, "the Zephyr service")).toHaveLength(1);
    expect(findMatches(term.regex, "Zephyrline")).toHaveLength(0);
  });

  it("still matches an ASCII term next to punctuation", () => {
    const term = compileTerm({ id: "a", value: "Zephyr" });
    expect(findMatches(term.regex, "vendor/Zephyr-adapter/x.ts")).toHaveLength(
      1,
    );
  });

  /**
   * The reason the tool takes a bring-your-own terms list rather than a regex:
   * `\b` is defined against [A-Za-z0-9_], so it never fires beside a Hangul
   * syllable. A term list that assumed word boundaries would silently match
   * nothing for exactly the terms that matter most.
   */
  it("does not apply ASCII boundaries to a non-ASCII term", () => {
    expect(shouldUseWordBoundary({ id: "ko", value: "노르헤이븐" })).toBe(
      false,
    );
    const term = compileTerm({ id: "ko", value: "노르헤이븐" });
    expect(findMatches(term.regex, "노르헤이븐 연동 메모")).toHaveLength(1);
    expect(findMatches(term.regex, "구 노르헤이븐데이터 이관")).toHaveLength(1);
  });

  it("shows what would happen if boundaries were forced onto a Hangul term", () => {
    const forced = compileTerm({
      id: "ko",
      value: "노르헤이븐",
      wholeWord: "always",
    });
    // Zero matches: the bug this design avoids.
    expect(findMatches(forced.regex, "노르헤이븐 연동 메모")).toHaveLength(0);
  });

  it("matches mixed scripts and Japanese and Han terms as substrings", () => {
    for (const value of ["ノルヘイブン", "北海醫療", "노르헤이븐-api"]) {
      const term = compileTerm({ id: value, value });
      expect(
        findMatches(term.regex, `prefix${value}suffix`).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe("case sensitivity", () => {
  it("is case-insensitive by default", () => {
    const term = compileTerm({ id: "a", value: "Zephyrline" });
    expect(findMatches(term.regex, "ZEPHYRLINE_QUEUE_URL")).toHaveLength(0); // boundary
    expect(findMatches(term.regex, "zephyrline gateway")).toHaveLength(1);
  });

  it("honours caseSensitive", () => {
    const term = compileTerm({
      id: "a",
      value: "Zephyrline",
      caseSensitive: true,
    });
    expect(findMatches(term.regex, "zephyrline gateway")).toHaveLength(0);
  });
});

describe("literal escaping", () => {
  it("treats regex metacharacters as literal text", () => {
    expect(escapeLiteral("a.b*c")).toBe("a\\.b\\*c");
    const term = compileTerm({ id: "a", value: "a.b" });
    expect(findMatches(term.regex, "axb")).toHaveLength(0);
    expect(findMatches(term.regex, "a.b")).toHaveLength(1);
  });

  it("handles a term that is an email domain", () => {
    const term = compileTerm({ id: "d", value: "zephyrline-internal.example" });
    expect(
      findMatches(term.regex, "dev@zephyrline-internal.example"),
    ).toHaveLength(1);
  });
});

describe("line numbers", () => {
  it("reports the line a match landed on", () => {
    const term = compileTerm({ id: "a", value: "target" });
    const matches = findMatches(term.regex, "one\ntwo\ntarget here\n");
    expect(matches[0]!.line).toBe(3);
  });
});
