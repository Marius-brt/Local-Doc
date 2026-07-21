import { describe, expect, test } from "bun:test";
import { chunkDocument } from "../src/chunk/index.ts";
import type { LocaldocConfig } from "../src/config/schema.ts";

const config = {
  data_dir: "~/.localdoc",
  chunking: {
    chunk_size: 512,
    min_characters: 24,
    table_rows: 3,
    overlap: 0,
  },
} as LocaldocConfig;

describe("fence-aware chunking", () => {
  test("keeps fenced code as code chunks", async () => {
    const md = `# Guide

Intro text about the API.

\`\`\`python
from sdk import Client
client = Client()
\`\`\`

More prose after the example.
`;
    const chunks = await chunkDocument(md, "doc.md", config);
    const code = chunks.filter((c) => c.kind === "code");
    expect(code.length).toBeGreaterThanOrEqual(1);
    expect(code[0]!.text).toContain("from sdk import Client");
    expect(code[0]!.language).toBe("python");
    expect(chunks.some((c) => c.kind === "prose" && c.text.includes("Intro text"))).toBe(true);
  });
});
