import { describe, expect, test } from "bun:test";
import { buildContextPack, formatPackMarkdown } from "../src/pack/format.ts";
import { isGithubInput, parseGithubUrl } from "../src/sources/github.ts";
import { estimateTokens } from "../src/util/estimate-tokens.ts";
import { sha256, shortId } from "../src/util/hash.ts";

describe("util", () => {
  test("estimateTokens", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });

  test("hash", () => {
    expect(sha256("x")).toHaveLength(64);
    expect(shortId("abc")).toHaveLength(16);
  });
});

describe("github parse", () => {
  test("https url", () => {
    const p = parseGithubUrl("https://github.com/oven-sh/bun");
    expect(p?.owner).toBe("oven-sh");
    expect(p?.repo).toBe("bun");
    expect(isGithubInput("github:oven-sh/bun")).toBe(true);
  });
});

describe("context pack", () => {
  test("respects budget", () => {
    const pack = buildContextPack(
      "q",
      [
        {
          chunkId: "1",
          documentId: "d",
          sourceId: "s",
          text: "hello world ".repeat(100),
          heading: null,
          sectionPath: null,
          uri: "u",
          title: "t",
          score: 1,
        },
      ],
      20,
    );
    expect(pack.sections.length).toBe(1);
    expect(pack.totalTokens).toBeLessThanOrEqual(25);
    expect(formatPackMarkdown(pack)).toContain("localdoc context pack");
  });
});
