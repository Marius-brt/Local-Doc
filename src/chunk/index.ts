import { CodeChunker, RecursiveChunker, TableChunker } from "@chonkiejs/core";
import type { LocaldocConfig } from "../config/schema.ts";
import { sha256 } from "../util/hash.ts";
import { expandHome } from "../util/paths.ts";
import { ensureChonkieWasm } from "./chonkie-wasm.ts";

export interface ChunkResult {
  text: string;
  heading: string | null;
  sectionPath: string | null;
  startOffset: number | null;
  endOffset: number | null;
  contentHash: string;
  kind: "prose" | "table" | "code";
}

const CODE_EXT: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".cs": "c_sharp",
  ".swift": "swift",
  ".scala": "scala",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
  ".r": "r",
  ".lua": "lua",
};

const TEXT_EXT = new Set([".md", ".mdx", ".txt", ".rst", ".html", ".htm", ".markdown"]);

export function isCodePath(pathOrUri: string): boolean {
  const lower = pathOrUri.toLowerCase();
  const idx = lower.lastIndexOf(".");
  if (idx < 0) return false;
  const ext = lower.slice(idx);
  return Boolean(CODE_EXT[ext]);
}

export function isTextDocPath(pathOrUri: string): boolean {
  const lower = pathOrUri.toLowerCase();
  const idx = lower.lastIndexOf(".");
  if (idx < 0) return true;
  const ext = lower.slice(idx);
  return TEXT_EXT.has(ext) || isCodePath(pathOrUri);
}

function languageFromPath(pathOrUri: string): string {
  const lower = pathOrUri.toLowerCase();
  const idx = lower.lastIndexOf(".");
  if (idx < 0) return "auto";
  return CODE_EXT[lower.slice(idx)] ?? "auto";
}

const TABLE_RE = /(?:^|\n)(\|[^\n]+\|\n\|[-:| ]+\|\n(?:\|[^\n]+\|\n?)+)/g;

function splitMarkdownTables(markdown: string): Array<{
  kind: "prose" | "table";
  text: string;
}> {
  const parts: Array<{ kind: "prose" | "table"; text: string }> = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(TABLE_RE.source, "g");
  while ((match = re.exec(markdown))) {
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    if (start > last) {
      parts.push({ kind: "prose", text: markdown.slice(last, start) });
    }
    parts.push({ kind: "table", text: match[1] ?? match[0].trim() });
    last = match.index + match[0].length;
  }
  if (last < markdown.length) {
    parts.push({ kind: "prose", text: markdown.slice(last) });
  }
  return parts.filter((p) => p.text.trim().length > 0);
}

function inferHeading(text: string): string | null {
  const m = text.match(/^#{1,6}\s+(.+)$/m);
  return m?.[1]?.trim() ?? null;
}

let recursiveChunker: Awaited<ReturnType<typeof RecursiveChunker.create>> | null = null;
let tableChunker: Awaited<ReturnType<typeof TableChunker.create>> | null = null;

async function getRecursive(config: LocaldocConfig) {
  if (!recursiveChunker) {
    recursiveChunker = await RecursiveChunker.create({
      chunkSize: config.chunking.chunk_size,
      minCharactersPerChunk: config.chunking.min_characters,
    });
  }
  return recursiveChunker;
}

async function getTable(config: LocaldocConfig) {
  if (!tableChunker) {
    tableChunker = await TableChunker.create({
      tokenizer: "row",
      chunkSize: config.chunking.table_rows,
    });
  }
  return tableChunker;
}

export async function chunkDocument(
  content: string,
  pathOrUri: string,
  config: LocaldocConfig,
): Promise<ChunkResult[]> {
  await ensureChonkieWasm(expandHome(config.data_dir));
  const results: ChunkResult[] = [];

  if (isCodePath(pathOrUri)) {
    try {
      const codeChunker = await CodeChunker.create({
        language: languageFromPath(pathOrUri),
        chunkSize: Math.max(config.chunking.chunk_size, 1024),
      });
      const chunks = codeChunker.chunk(content);
      for (const c of chunks) {
        const text = c.text.trim();
        if (!text) continue;
        results.push({
          text,
          heading: null,
          sectionPath: pathOrUri,
          startOffset: c.startIndex ?? null,
          endOffset: c.endIndex ?? null,
          contentHash: sha256(text),
          kind: "code",
        });
      }
      if (results.length > 0) return results;
    } catch {
      // fall through to recursive
    }
  }

  // Treat as markdown (normalize plain text as md)
  const markdown = content;
  const parts = splitMarkdownTables(markdown);
  const recursive = await getRecursive(config);
  const table = await getTable(config);

  for (const part of parts) {
    if (part.kind === "table") {
      try {
        const chunks = table.chunk(part.text);
        for (const c of chunks) {
          const text = c.text.trim();
          if (!text) continue;
          results.push({
            text,
            heading: "table",
            sectionPath: pathOrUri,
            startOffset: null,
            endOffset: null,
            contentHash: sha256(text),
            kind: "table",
          });
        }
      } catch {
        results.push({
          text: part.text.trim(),
          heading: "table",
          sectionPath: pathOrUri,
          startOffset: null,
          endOffset: null,
          contentHash: sha256(part.text.trim()),
          kind: "table",
        });
      }
    } else {
      const chunks = await recursive.chunk(part.text);
      for (const c of chunks) {
        const text = c.text.trim();
        if (!text) continue;
        results.push({
          text,
          heading: inferHeading(text),
          sectionPath: pathOrUri,
          startOffset: c.startIndex ?? null,
          endOffset: c.endIndex ?? null,
          contentHash: sha256(text),
          kind: "prose",
        });
      }
    }
  }

  return results;
}
