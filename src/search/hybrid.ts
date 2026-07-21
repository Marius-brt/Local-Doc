import type { Client } from "@libsql/client";
import type { LocaldocConfig } from "../config/schema.ts";
import type { Embedder } from "../embed/index.ts";
import { flushLog, formatError, log } from "../util/log.ts";
import {
  buildFilterSql,
  hasSearchFilters,
  hitMatchesFilters,
  type SearchFilters,
} from "./filters.ts";
import { type RankedHit, rerankResults } from "./rerank.ts";

export type { ChunkKind, SearchFilters } from "./filters.ts";
export { parseChunkKinds, splitList } from "./filters.ts";

export interface SearchHit {
  chunkId: string;
  documentId: string;
  sourceId: string;
  text: string;
  heading: string | null;
  sectionPath: string | null;
  uri: string;
  title: string | null;
  score: number;
}

function rrfFuse(lists: SearchHit[][], k: number): Map<string, { hit: SearchHit; score: number }> {
  const scores = new Map<string, { hit: SearchHit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const add = 1 / (k + rank + 1);
      const prev = scores.get(hit.chunkId);
      if (prev) {
        prev.score += add;
      } else {
        scores.set(hit.chunkId, { hit, score: add });
      }
    });
  }
  return scores;
}

function escapeFtsToken(token: string): string | null {
  const cleaned = token.replace(/["']/g, " ").trim();
  if (!cleaned) return null;
  return `"${cleaned}"`;
}

function escapeFts(query: string): string {
  return query
    .split(/\s+/)
    .map(escapeFtsToken)
    .filter((t): t is string => Boolean(t))
    .join(" OR ");
}

/** Natural-language query ORed, with required keywords ANDed. */
function buildFtsMatch(query: string, keywords: string[] | undefined): string {
  const base = escapeFts(query);
  const required = (keywords ?? []).map(escapeFtsToken).filter((t): t is string => Boolean(t));
  if (!base && required.length === 0) return "";
  if (!base) return required.join(" AND ");
  if (required.length === 0) return base;
  return `(${base}) AND ${required.join(" AND ")}`;
}

function rowToHit(row: Record<string, unknown>, score: number): SearchHit {
  return {
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    sourceId: String(row.source_id),
    text: String(row.text),
    heading: row.heading == null ? null : String(row.heading),
    sectionPath: row.section_path == null ? null : String(row.section_path),
    uri: String(row.uri),
    title: row.title == null ? null : String(row.title),
    score,
  };
}

async function ftsSearch(
  db: Client,
  query: string,
  limit: number,
  filters?: SearchFilters,
): Promise<SearchHit[]> {
  const ftsQuery = buildFtsMatch(query, filters?.keywords);
  const filter = buildFilterSql(filters);
  if (!ftsQuery && !hasSearchFilters(filters)) return [];

  if (ftsQuery) {
    try {
      const res = await db.execute({
        sql: `
          SELECT c.id AS chunk_id, c.document_id, c.source_id, c.text, c.heading, c.section_path,
                 d.uri, d.title, bm25(chunks_fts) AS rank
          FROM chunks_fts
          JOIN chunks c ON c.rowid = chunks_fts.rowid
          JOIN documents d ON d.id = c.document_id
          WHERE chunks_fts MATCH ?${filter.sql}
          ORDER BY rank
          LIMIT ?
        `,
        args: [ftsQuery, ...filter.args, limit],
      });
      return res.rows.map((row) =>
        rowToHit(row as Record<string, unknown>, -Number(row.rank ?? 0)),
      );
    } catch {
      // Fallback LIKE search if FTS query fails
    }
  }

  const likeParts: string[] = [];
  const likeArgs: string[] = [];
  const firstToken = query.split(/\s+/).filter(Boolean)[0];
  if (firstToken) {
    likeParts.push("instr(lower(c.text), lower(?)) > 0");
    likeArgs.push(firstToken);
  }
  // Keywords are already in filter.sql via buildFilterSql
  if (likeParts.length === 0 && !filter.sql) return [];

  const whereExtra = likeParts.length ? ` AND ${likeParts.join(" AND ")}` : "";
  const res = await db.execute({
    sql: `
      SELECT c.id AS chunk_id, c.document_id, c.source_id, c.text, c.heading, c.section_path,
             d.uri, d.title
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE 1=1${filter.sql}${whereExtra}
      LIMIT ?
    `,
    args: [...filter.args, ...likeArgs, limit],
  });
  return res.rows.map((row, i) => rowToHit(row as Record<string, unknown>, 1 / (i + 1)));
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function blobToFloat32(blob: unknown, dims: number): Float32Array {
  if (blob instanceof ArrayBuffer) {
    return new Float32Array(blob.slice(0, dims * 4));
  }
  if (ArrayBuffer.isView(blob)) {
    const view = blob as ArrayBufferView;
    return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + dims * 4));
  }
  if (typeof blob === "string") {
    // unlikely
    return new Float32Array(0);
  }
  // libsql may return Uint8Array / Buffer
  const buf = Buffer.from(blob as Buffer);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

async function vectorSearch(
  db: Client,
  queryVec: Float32Array,
  limit: number,
  filters?: SearchFilters,
): Promise<SearchHit[]> {
  const filter = buildFilterSql(filters);
  // Over-fetch when filtering so post-join WHERE does not starve the result set.
  const candidateLimit = hasSearchFilters(filters) ? Math.max(limit * 5, limit) : limit;

  // Try libSQL vector_top_k first
  try {
    const res = await db.execute({
      sql: `
        SELECT c.id AS chunk_id, c.document_id, c.source_id, c.text, c.heading, c.section_path,
               d.uri, d.title, e.dims
        FROM vector_top_k('chunk_embeddings_idx', vector32(?), ?) AS v
        JOIN chunk_embeddings e ON e.rowid = v.rowid
        JOIN chunks c ON c.id = e.chunk_id
        JOIN documents d ON d.id = c.document_id
        WHERE 1=1${filter.sql}
      `,
      args: [
        Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength),
        candidateLimit,
        ...filter.args,
      ],
    });
    if (res.rows.length > 0) {
      return res.rows
        .map((row, i) => rowToHit(row as Record<string, unknown>, 1 / (i + 1)))
        .filter((hit) => hitMatchesFilters(hit, filters))
        .slice(0, limit);
    }
  } catch {
    // fallback to brute-force cosine
  }

  const res = await db.execute({
    sql: `
      SELECT c.id AS chunk_id, c.document_id, c.source_id, c.text, c.heading, c.section_path,
             d.uri, d.title, e.embedding, e.dims
      FROM chunk_embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE 1=1${filter.sql}
    `,
    args: filter.args,
  });

  const scored: SearchHit[] = [];
  for (const row of res.rows) {
    const dims = Number(row.dims);
    const vec = blobToFloat32(row.embedding, dims);
    const score = cosine(queryVec, vec);
    scored.push(rowToHit(row as Record<string, unknown>, score));
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function hybridSearch(
  db: Client,
  query: string,
  config: LocaldocConfig,
  embedder: Embedder | null,
  filters?: SearchFilters,
): Promise<SearchHit[]> {
  log.info(
    `query start q=${JSON.stringify(query.slice(0, 120))} embedder=${embedder?.modelId ?? "none"} rerank=${config.rerank.enabled ? config.rerank.provider : "off"} filters=${hasSearchFilters(filters) ? JSON.stringify({ kinds: filters?.kinds, sources: filters?.sourceIds?.length, keywords: filters?.keywords?.length }) : "none"}`,
  );
  const ftsHits = await ftsSearch(db, query, config.search.fts_limit, filters);

  let vectorHits: SearchHit[] = [];
  if (embedder) {
    try {
      const queryVec = await embedder.embedOne(query);
      vectorHits = await vectorSearch(db, queryVec, config.search.vector_limit, filters);
    } catch (err) {
      log.error(`vector search unavailable (${formatError(err)}); using FTS only`);
      await flushLog();
    }
  }

  const lists = vectorHits.length > 0 ? [ftsHits, vectorHits] : [ftsHits];
  const fused = rrfFuse(lists, config.search.rrf_k);
  let ranked: RankedHit[] = [...fused.values()]
    .map(({ hit, score }) => ({ ...hit, score }))
    .sort((a, b) => b.score - a.score);

  if (config.rerank.enabled && config.rerank.provider !== "none") {
    try {
      ranked = await rerankResults(query, ranked, config);
    } catch (err) {
      log.error(`rerank failed; returning unre-ranked hits: ${formatError(err)}`);
      await flushLog();
      // Keep hybrid ranking so a bad rerank provider does not blank the query UI.
    }
  }

  const out = ranked.slice(0, config.search.top_k);
  log.info(`query done hits=${out.length} (fts=${ftsHits.length} vector=${vectorHits.length})`);
  return out;
}
