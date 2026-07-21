import { describe, expect, test } from "bun:test";
import {
  buildContextPack,
  cleanChunkText,
  cleanHeading,
  formatPackMarkdown,
  isNearDuplicate,
} from "../src/pack/format.ts";
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

describe("pack cleaning", () => {
  test("cleanHeading strips empty anchor noise", () => {
    expect(cleanHeading(`Examples[](#examples-8 "Direct link to Examples")`)).toBe("Examples");
    expect(cleanHeading(`Documentation[](#documentation-6 "Direct link to Documentation")`)).toBe(
      "Documentation",
    );
  });

  test("cleanChunkText removes anchors and collapses blank lines", () => {
    const raw = `Hello[](#x "Direct link to Hello")\n\n\n\nWorld [docs](https://example.com)`;
    const cleaned = cleanChunkText(raw);
    expect(cleaned).not.toContain("[](");
    expect(cleaned).toContain("World docs");
    expect(cleaned).not.toMatch(/\n{3,}/);
  });

  test("isNearDuplicate detects twins", () => {
    const a = "from ragflow_sdk import RAGFlow\nrag_object = RAGFlow(api_key='x')\n".repeat(3);
    const b = `${a}\n# trailing comment`;
    expect(isNearDuplicate(a, a)).toBe(true);
    expect(isNearDuplicate(a, b)).toBe(true);
    expect(isNearDuplicate(a, "totally different documentation about auth cookies")).toBe(false);
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
    expect(formatPackMarkdown(pack)).toContain("# q");
  });

  test("per-section cap leaves room for more hits", () => {
    const hits = Array.from({ length: 4 }, (_, i) => ({
      chunkId: String(i),
      documentId: `d${i}`,
      sourceId: "s",
      text: "word ".repeat(200),
      heading: null,
      sectionPath: null,
      uri: `u${i}`,
      title: "t",
      score: 1 - i * 0.1,
    }));
    const pack = buildContextPack("q", hits, 200);
    expect(pack.sections.length).toBeGreaterThan(1);
    expect(pack.totalTokens).toBeLessThanOrEqual(200);
  });

  test("dedupes near-identical chunks and formats compactly", () => {
    const body = `
## Examples[](#examples-8 "Direct link to Examples")

\`\`\`python
from ragflow_sdk import RAGFlow
rag_object = RAGFlow(api_key="<YOUR_API_KEY>", base_url="http://localhost")
dataset = rag_object.create_dataset(name="kb_1")
\`\`\`
`.repeat(1);

    const pack = buildContextPack(
      "how to create a dataset using python sdk",
      [
        {
          chunkId: "1",
          documentId: "d1",
          sourceId: "s",
          text: body,
          heading: `Examples[](#examples-8 "Direct link to Examples")`,
          sectionPath: null,
          uri: "https://ragflow.io/docs/python_api_reference",
          title: "Python API | RAGFlow",
          score: 1,
        },
        {
          chunkId: "2",
          documentId: "d2",
          sourceId: "s",
          text: `${body}\n`,
          heading: `Examples[](#examples-8 "Direct link to Examples")`,
          sectionPath: null,
          uri: "https://ragflow.io/docs/v0.26.4/python_api_reference",
          title: "Python API | RAGFlow",
          score: 0.9,
        },
        {
          chunkId: "3",
          documentId: "d3",
          sourceId: "s",
          text: "HTTP and Python APIs for dataset management.",
          heading: `Documentation[](#documentation-6 "Direct link to Documentation")`,
          sectionPath: null,
          uri: "https://ragflow.io/docs/release_notes",
          title: "Release notes",
          score: 0.5,
        },
      ],
      2400,
    );

    expect(pack.sections.length).toBe(2);
    expect(pack.sections[0]!.heading).toBe("Examples");
    const md = formatPackMarkdown(pack);
    expect(md).toContain("# how to create a dataset using python sdk");
    expect(md).toContain("## 1. Examples");
    expect(md).toContain("https://ragflow.io/docs/python_api_reference");
    expect(md).not.toContain("Source:");
    expect(md).not.toContain("Tokens:");
    expect(md).not.toContain("[](#");
    expect(md).not.toContain("Direct link");
    expect(md).toContain("## 2. Documentation");
  });
});
