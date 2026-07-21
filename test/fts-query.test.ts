import { describe, expect, test } from "bun:test";
import { headingAtOffset, inferCodeHeading } from "../src/chunk/index.ts";
import { truncateAtBoundary } from "../src/pack/format.ts";
import { embedTextForChunk } from "../src/search/embed-text.ts";
import { hitMatchesFilters } from "../src/search/filters.ts";
import {
  buildFtsQuery,
  isMultilingualStopword,
  significantTokens,
  tokenizeQuery,
} from "../src/search/fts-query.ts";
import { diversifyByDocument } from "../src/search/hybrid.ts";

describe("fts query builder", () => {
  test("drops multilingual stopwords and ANDs content terms", () => {
    const q = buildFtsQuery("how to authenticate JWT");
    expect(q.tokens).toContain("authenticate");
    expect(q.tokens).toContain("JWT");
    expect(q.tokens).not.toContain("how");
    expect(q.tokens).not.toContain("to");
    // 2 content terms → NEAR
    expect(q.primary).toContain("NEAR(");
    expect(q.fallbackOr).toContain(" OR ");
  });

  test("French function words are stopwords", () => {
    const q = buildFtsQuery("comment authentifier JWT");
    expect(isMultilingualStopword("comment")).toBe(true);
    expect(q.tokens).toContain("authentifier");
    expect(q.tokens).toContain("JWT");
    expect(q.tokens.map((t) => t.toLowerCase())).not.toContain("comment");
  });

  test("German function words are stopwords", () => {
    const q = buildFtsQuery("wie authentifizieren JWT");
    expect(q.tokens).toContain("authentifizieren");
    expect(q.tokens.map((t) => t.toLowerCase())).not.toContain("wie");
  });

  test("preserves quoted phrases", () => {
    const parts = tokenizeQuery(`find "bearer token" auth`);
    expect(parts.some((p) => p.type === "phrase" && p.value === "bearer token")).toBe(true);
    const q = buildFtsQuery(`find "bearer token" auth`);
    expect(q.primary).toContain('"bearer token"');
  });

  test("keywords are ANDed", () => {
    const q = buildFtsQuery("auth", ["Bearer", "token"]);
    expect(q.primary).toContain("AND");
    expect(q.primary).toContain('"Bearer"');
    expect(q.primary).toContain('"token"');
  });

  test("keeps originals when stopword filter would leave too few tokens", () => {
    const q = buildFtsQuery("how to");
    expect(significantTokens("how to").length).toBeGreaterThan(0);
    expect(q.primary.length).toBeGreaterThan(0);
  });

  test("strips unicode edge punctuation", () => {
    const q = buildFtsQuery("authenticate？ JWT！");
    expect(q.tokens.some((t) => t.includes("authenticate"))).toBe(true);
    expect(q.tokens.some((t) => t.includes("JWT"))).toBe(true);
  });
});

describe("diversifyByDocument", () => {
  test("caps hits per document", () => {
    const hits = [
      {
        chunkId: "1",
        documentId: "a",
        sourceId: "s",
        text: "x",
        heading: null,
        sectionPath: null,
        uri: "u",
        title: null,
        score: 3,
      },
      {
        chunkId: "2",
        documentId: "a",
        sourceId: "s",
        text: "y",
        heading: null,
        sectionPath: null,
        uri: "u",
        title: null,
        score: 2,
      },
      {
        chunkId: "3",
        documentId: "a",
        sourceId: "s",
        text: "z",
        heading: null,
        sectionPath: null,
        uri: "u",
        title: null,
        score: 1,
      },
      {
        chunkId: "4",
        documentId: "b",
        sourceId: "s",
        text: "w",
        heading: null,
        sectionPath: null,
        uri: "u",
        title: null,
        score: 0.5,
      },
    ];
    const out = diversifyByDocument(hits, 2);
    expect(out.map((h) => h.chunkId)).toEqual(["1", "2", "4"]);
  });
});

describe("pack truncateAtBoundary", () => {
  test("prefers paragraph boundary", () => {
    const text = "alpha beta gamma.\n\ndelta epsilon zeta eta theta.";
    const out = truncateAtBoundary(text, 28);
    expect(out).toContain("…");
    expect(out).toContain("alpha");
  });
});

describe("chunk headings", () => {
  test("headingAtOffset builds breadcrumbs", () => {
    const md = `# Intro\n\npara\n\n## Auth\n\n## Setup\n\n### Steps\n\nbody`;
    const headings = [
      { offset: 0, level: 1, title: "Intro" },
      { offset: md.indexOf("## Auth"), level: 2, title: "Auth" },
      { offset: md.indexOf("## Setup"), level: 2, title: "Setup" },
      { offset: md.indexOf("### Steps"), level: 3, title: "Steps" },
    ];
    const at = headingAtOffset(md.indexOf("body"), headings);
    expect(at.heading).toBe("Steps");
    expect(at.sectionPath).toBe("Intro > Setup > Steps");
  });

  test("inferCodeHeading prefers symbol names over raw syntax", () => {
    expect(inferCodeHeading("export function login() {\n  return 1;\n}")).toBe("login");
    expect(
      inferCodeHeading(
        `describe("context pack", () => {\n  test("x", () => {});\n}`,
        "pack.test.ts",
      ),
    ).toBe("context pack");
    expect(inferCodeHeading("const x = 1;\n", "src/util/hash.ts")).toBe("x");
  });
});

describe("embed text", () => {
  test("prefixes title and section path", () => {
    expect(embedTextForChunk({ title: "Docs", sectionPath: "A > B", text: "body" })).toBe(
      "Docs\nA > B\n\nbody",
    );
  });
});

describe("hitMatchesFilters kinds", () => {
  test("rejects wrong kind when present", () => {
    expect(
      hitMatchesFilters({ sourceId: "s", text: "x", kind: "prose" }, { kinds: ["code"] }),
    ).toBe(false);
    expect(hitMatchesFilters({ sourceId: "s", text: "x", kind: "code" }, { kinds: ["code"] })).toBe(
      true,
    );
  });
});
