import { CodeChunker, RecursiveChunker, TableChunker } from "@chonkiejs/core";
import type { LocaldocConfig } from "../config/schema.ts";
import { cleanHeading } from "../extract/sanitize.ts";
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
  /** Fenced code language tag when kind is code. */
  language?: string | null;
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
const FENCE_RE = /(?:^|\n)(```([\w+-]*)\r?\n[\s\S]*?\r?\n```)/g;

type MdPart = {
  kind: "prose" | "table" | "code";
  text: string;
  start: number;
  language?: string | null;
};

function splitMarkdownTables(markdown: string, baseOffset = 0): MdPart[] {
  const parts: MdPart[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(TABLE_RE.source, "g");
  while ((match = re.exec(markdown))) {
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    if (start > last) {
      parts.push({
        kind: "prose",
        text: markdown.slice(last, start),
        start: baseOffset + last,
      });
    }
    parts.push({
      kind: "table",
      text: match[1] ?? match[0].trim(),
      start: baseOffset + start,
    });
    last = match.index + match[0].length;
  }
  if (last < markdown.length) {
    parts.push({
      kind: "prose",
      text: markdown.slice(last),
      start: baseOffset + last,
    });
  }
  return parts.filter((p) => p.text.trim().length > 0);
}

/** Split fenced code out before recursive prose chunking; tables within prose regions. */
function splitMarkdownParts(markdown: string): MdPart[] {
  const parts: MdPart[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(FENCE_RE.source, "g");
  while ((match = re.exec(markdown))) {
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    if (start > last) {
      parts.push(...splitMarkdownTables(markdown.slice(last, start), last));
    }
    const fence = match[1] ?? match[0].trim();
    const lang = (match[2] || "").trim() || null;
    parts.push({ kind: "code", text: fence.trim(), start, language: lang });
    last = match.index + match[0].length;
  }
  if (last < markdown.length) {
    parts.push(...splitMarkdownTables(markdown.slice(last), last));
  }
  return parts.filter((p) => p.text.trim().length > 0);
}

interface HeadingMark {
  offset: number;
  level: number;
  title: string;
}

function collectHeadings(markdown: string): HeadingMark[] {
  const headings: HeadingMark[] = [];
  const re = /^(#{1,6})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    const title = cleanHeading(m[2]!.trim()) ?? m[2]!.trim();
    headings.push({
      offset: m.index,
      level: m[1]!.length,
      title,
    });
  }
  return headings;
}

/** Nearest heading + breadcrumb path at a document offset. */
export function headingAtOffset(
  offset: number,
  headings: HeadingMark[],
): { heading: string | null; sectionPath: string | null } {
  const stack: HeadingMark[] = [];
  for (const h of headings) {
    if (h.offset > offset) break;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) {
      stack.pop();
    }
    stack.push(h);
  }
  if (stack.length === 0) return { heading: null, sectionPath: null };
  return {
    heading: stack[stack.length - 1]!.title,
    sectionPath: stack.map((h) => h.title).join(" > "),
  };
}

/** Basename without query/hash — used when no clean symbol heading exists. */
export function fileStemFromPath(pathOrUri: string): string | null {
  try {
    const pathPart = pathOrUri.includes("://")
      ? decodeURIComponent(new URL(pathOrUri).pathname)
      : pathOrUri;
    const base = pathPart.split("/").pop() || pathPart;
    return base || null;
  } catch {
    const base = pathOrUri.split("/").pop();
    return base || null;
  }
}

/**
 * Infer a short human/agent-friendly heading for a code chunk.
 * Avoids using raw syntax like `describe("…", () => {` as the title.
 */
export function inferCodeHeading(text: string, pathOrUri?: string): string | null {
  const lines = text.split("\n").slice(0, 16);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("<!--") ||
      trimmed.startsWith("import ") ||
      trimmed.startsWith("from ") ||
      trimmed.startsWith("require(") ||
      trimmed.startsWith("use ") ||
      trimmed.startsWith("package ")
    ) {
      continue;
    }

    // test("name") / it("name") / describe("name") → name
    const suite = trimmed.match(
      /^(?:describe|context|suite|test|it|specify)\s*\(\s*['"`]([^'"`]+)['"`]/,
    );
    if (suite?.[1]) return suite[1].slice(0, 120);

    // function foo / class Bar / const baz =
    const fn = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/);
    if (fn?.[1]) return fn[1];
    const cls = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+(\w+)/);
    if (cls?.[1]) return cls[1];
    const def = trimmed.match(/^(?:async\s+)?def\s+(\w+)/);
    if (def?.[1]) return def[1];
    const rustFn = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
    if (rustFn?.[1]) return rustFn[1];
    const goFn = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)/);
    if (goFn?.[1]) return goFn[1];
    const constName = trimmed.match(/^(?:export\s+)?(?:const|let|var|type|interface|enum)\s+(\w+)/);
    if (constName?.[1]) return constName[1];

    // Full signature only if it looks like a declaration (not a call / block open)
    if (
      /^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum)\b/.test(trimmed) ||
      /^(pub\s+)?(async\s+)?(fn|struct|impl|trait|mod|enum)\b/.test(trimmed) ||
      /^(async\s+)?def\s+\w+/.test(trimmed) ||
      /^func\s+\w+/.test(trimmed)
    ) {
      // Strip trailing `{` / `=` noise for display
      return trimmed.replace(/\s*[{=]\s*$/, "").slice(0, 120);
    }
  }

  // Never fall back to a random first line of syntax — prefer filename.
  return fileStemFromPath(pathOrUri ?? "") ?? null;
}

function applyOverlap(chunks: ChunkResult[], overlap: number): ChunkResult[] {
  if (overlap <= 0 || chunks.length <= 1) return chunks;
  const out: ChunkResult[] = [chunks[0]!];
  for (let i = 1; i < chunks.length; i++) {
    const prev = out[out.length - 1]!;
    const cur = chunks[i]!;
    // Only overlap within the same kind continuum
    if (prev.kind !== cur.kind) {
      out.push(cur);
      continue;
    }
    const prefix = prev.text.slice(-overlap);
    if (!prefix || cur.text.startsWith(prefix)) {
      out.push(cur);
      continue;
    }
    const text = `${prefix}\n${cur.text}`;
    out.push({
      ...cur,
      text,
      contentHash: sha256(text),
    });
  }
  return out;
}

type ChunkerKey = string;

const recursiveCache = new Map<ChunkerKey, Awaited<ReturnType<typeof RecursiveChunker.create>>>();
const tableCache = new Map<ChunkerKey, Awaited<ReturnType<typeof TableChunker.create>>>();

async function getRecursive(config: LocaldocConfig) {
  const key = `${config.chunking.chunk_size}:${config.chunking.min_characters}`;
  let chunker = recursiveCache.get(key);
  if (!chunker) {
    chunker = await RecursiveChunker.create({
      chunkSize: config.chunking.chunk_size,
      minCharactersPerChunk: config.chunking.min_characters,
    });
    recursiveCache.set(key, chunker);
  }
  return chunker;
}

async function getTable(config: LocaldocConfig) {
  const key = String(config.chunking.table_rows);
  let chunker = tableCache.get(key);
  if (!chunker) {
    chunker = await TableChunker.create({
      tokenizer: "row",
      chunkSize: config.chunking.table_rows,
    });
    tableCache.set(key, chunker);
  }
  return chunker;
}

export async function chunkDocument(
  content: string,
  pathOrUri: string,
  config: LocaldocConfig,
): Promise<ChunkResult[]> {
  await ensureChonkieWasm(expandHome(config.data_dir));
  const results: ChunkResult[] = [];
  const overlap = config.chunking.overlap ?? 0;

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
          heading: inferCodeHeading(text, pathOrUri),
          sectionPath: null,
          startOffset: c.startIndex ?? null,
          endOffset: c.endIndex ?? null,
          contentHash: sha256(text),
          kind: "code",
        });
      }
      if (results.length > 0) return applyOverlap(results, overlap);
    } catch {
      // fall through to recursive
    }
  }

  const markdown = content;
  const headings = collectHeadings(markdown);
  const parts = splitMarkdownParts(markdown);
  const recursive = await getRecursive(config);
  const table = await getTable(config);

  for (const part of parts) {
    if (part.kind === "code") {
      const text = part.text.trim();
      if (!text) continue;
      const meta = headingAtOffset(part.start, headings);
      results.push({
        text,
        heading: meta.heading ?? inferCodeHeading(text, pathOrUri),
        sectionPath: meta.sectionPath,
        startOffset: part.start,
        endOffset: part.start + text.length,
        contentHash: sha256(text),
        kind: "code",
        language: part.language ?? null,
      });
      continue;
    }

    if (part.kind === "table") {
      const meta = headingAtOffset(part.start, headings);
      try {
        const chunks = table.chunk(part.text);
        for (const c of chunks) {
          const text = c.text.trim();
          if (!text) continue;
          results.push({
            text,
            heading: meta.heading,
            sectionPath: meta.sectionPath,
            startOffset: null,
            endOffset: null,
            contentHash: sha256(text),
            kind: "table",
          });
        }
      } catch {
        const text = part.text.trim();
        results.push({
          text,
          heading: meta.heading,
          sectionPath: meta.sectionPath,
          startOffset: null,
          endOffset: null,
          contentHash: sha256(text),
          kind: "table",
        });
      }
      continue;
    }

    const chunks = await recursive.chunk(part.text);
    for (const c of chunks) {
      const text = c.text.trim();
      if (!text) continue;
      const localStart = c.startIndex ?? part.text.indexOf(c.text);
      const absOffset =
        localStart >= 0
          ? part.start + localStart
          : part.start + Math.max(0, part.text.indexOf(text));
      const meta = headingAtOffset(absOffset, headings);
      results.push({
        text,
        heading: meta.heading,
        sectionPath: meta.sectionPath,
        startOffset: c.startIndex != null ? part.start + c.startIndex : null,
        endOffset: c.endIndex != null ? part.start + c.endIndex : null,
        contentHash: sha256(text),
        kind: "prose",
      });
    }
  }

  return applyOverlap(results, overlap);
}
