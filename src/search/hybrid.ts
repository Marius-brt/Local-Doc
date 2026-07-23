import type { Client } from "@libsql/client";
import type { LocaldocConfig } from "../config/schema.ts";
import type { Embedder } from "../embed/index.ts";
import { flushLog, formatError, log } from "../util/log.ts";
import { expandHome } from "../util/paths.ts";
import {
  buildFilterSql,
  hasSearchFilters,
  hitMatchesFilters,
  type SearchFilters,
} from "./filters.ts";
import { buildFtsQuery, significantTokens } from "./fts-query.ts";
import { type RankedHit, rerankResults } from "./rerank.ts";

export type { ChunkKind, SearchFilters } from "./filters.ts";
export { parseChunkKinds, splitList } from "./filters.ts";
export { buildFtsQuery, significantTokens } from "./fts-query.ts";

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
  kind?: string | null;
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

function rowToHit(row: Record<string, unknown>, score: number): SearchHit {
  const kindRaw = row.kind;
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
    kind: kindRaw == null ? null : String(kindRaw),
  };
}

const HIT_SELECT = `
  c.id AS chunk_id, c.document_id, c.source_id, c.text, c.heading, c.section_path,
  d.uri, d.title, json_extract(c.meta_json, '$.kind') AS kind
`;

/** Only searchable documents contribute to hybrid results. */
const DOC_OK = ` AND d.status = 'ok'`;

/** Weighted BM25: text, heading, section_path, title (title may be absent on very old DBs). */
const BM25_WEIGHTED = "bm25(chunks_fts, 1.0, 8.0, 2.0, 6.0)";
const BM25_LEGACY = "bm25(chunks_fts, 1.0, 8.0, 2.0)";

async function ftsMatchOnce(
  db: Client,
  match: string,
  limit: number,
  filterSql: string,
  filterArgs: string[],
  weighted: boolean,
): Promise<SearchHit[]> {
  const bm25 = weighted ? BM25_WEIGHTED : BM25_LEGACY;
  const res = await db.execute({
    sql: `
      SELECT ${HIT_SELECT}, ${bm25} AS rank
      FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH ?${filterSql}${DOC_OK}
      ORDER BY rank
      LIMIT ?
    `,
    args: [match, ...filterArgs, limit],
  });
  return res.rows.map((row) => rowToHit(row as Record<string, unknown>, -Number(row.rank ?? 0)));
}

async function ftsSearch(
  db: Client,
  query: string,
  limit: number,
  filters?: SearchFilters,
): Promise<SearchHit[]> {
  const built = buildFtsQuery(query, filters?.keywords);
  // Keywords are in MATCH; omit duplicate instr predicates on the FTS path.
  const filter = buildFilterSql(filters, "c", { includeKeywords: false });
  if (!built.primary && !hasSearchFilters(filters)) return [];

  const tryMatch = async (match: string): Promise<SearchHit[] | null> => {
    if (!match) return null;
    try {
      return await ftsMatchOnce(db, match, limit, filter.sql, filter.args, true);
    } catch {
      // Older 3-column FTS: retry without title weight.
      try {
        return await ftsMatchOnce(db, match, limit, filter.sql, filter.args, false);
      } catch (err2) {
        log.warn(`FTS MATCH failed: ${formatError(err2)}; falling back`);
        await flushLog();
        return null;
      }
    }
  };

  if (built.primary) {
    const primaryHits = await tryMatch(built.primary);
    if (primaryHits && primaryHits.length > 0) return primaryHits;
    // Soft OR fallback when AND/NEAR is too strict.
    if (built.fallbackOr && built.fallbackOr !== built.primary) {
      const orHits = await tryMatch(built.fallbackOr);
      if (orHits && orHits.length > 0) return orHits;
      if (orHits) return orHits; // empty but FTS worked
    } else if (primaryHits) {
      return primaryHits;
    }
  }

  // LIKE fallback: AND all significant tokens, order by earliest match.
  const tokens = significantTokens(query);
  const likeParts: string[] = [];
  const likeArgs: string[] = [];
  for (const t of tokens) {
    likeParts.push("instr(lower(c.text), lower(?)) > 0");
    likeArgs.push(t);
  }
  const kwFilter = buildFilterSql(filters, "c", { includeKeywords: true });
  if (likeParts.length === 0 && !kwFilter.sql) return [];

  const whereExtra = likeParts.length ? ` AND ${likeParts.join(" AND ")}` : "";
  const orderExpr = tokens[0] != null ? "instr(lower(c.text), lower(?))" : "c.rowid";
  const orderArgs = tokens[0] != null ? [tokens[0]] : [];

  const res = await db.execute({
    sql: `
      SELECT ${HIT_SELECT}
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE 1=1${kwFilter.sql}${whereExtra}${DOC_OK}
      ORDER BY ${orderExpr}
      LIMIT ?
    `,
    args: [...kwFilter.args, ...likeArgs, ...orderArgs, limit],
  });
  return res.rows.map((row, i) => rowToHit(row as Record<string, unknown>, 1 / (i + 1)));
}

function cosine(a: Float32Array, b: Float32Array): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
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
    return new Float32Array(0);
  }
  const buf = Buffer.from(blob as Buffer);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

async function bruteForceVectorSearch(
  db: Client,
  queryVec: Float32Array,
  limit: number,
  filters: SearchFilters | undefined,
  modelId: string | null,
): Promise<SearchHit[]> {
  const filter = buildFilterSql(filters, "c", { includeKeywords: true });
  const modelClause = modelId ? " AND e.model_id = ?" : "";
  const modelArgs = modelId ? [modelId] : [];

  const res = await db.execute({
    sql: `
      SELECT ${HIT_SELECT}, e.embedding, e.dims, e.model_id
      FROM chunk_embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE 1=1${filter.sql}${modelClause}${DOC_OK}
    `,
    args: [...filter.args, ...modelArgs],
  });

  const scored: SearchHit[] = [];
  for (const row of res.rows) {
    const dims = Number(row.dims);
    if (dims !== queryVec.length) continue;
    const vec = blobToFloat32(row.embedding, dims);
    if (vec.length !== queryVec.length) continue;
    const score = cosine(queryVec, vec);
    if (score == null) continue;
    const hit = rowToHit(row as Record<string, unknown>, score);
    if (!hitMatchesFilters(hit, filters)) continue;
    scored.push(hit);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

async function vectorSearch(
  db: Client,
  queryVec: Float32Array,
  limit: number,
  filters: SearchFilters | undefined,
  modelId: string | null,
): Promise<SearchHit[]> {
  const filtering = hasSearchFilters(filters);
  // libSQL `vector_top_k` + SQL predicates on `chunks` (especially source_id) is
  // pathologically slow — tens of seconds per call when the filter starves ANN.
  // Source-scoped queries: skip ANN and score that subset directly (milliseconds).
  if ((filters?.sourceIds?.length ?? 0) > 0) {
    return bruteForceVectorSearch(db, queryVec, limit, filters, modelId);
  }

  // kinds/keywords: ANN without SQL chunk filters, post-filter in JS, then escalate.
  const overFetchSteps = filtering ? [5, 10, 20] : [1];

  for (const mult of overFetchSteps) {
    const candidateLimit = Math.max(limit * mult, limit);
    try {
      const res = await db.execute({
        sql: `
          SELECT ${HIT_SELECT}, e.dims, e.embedding, e.model_id
          FROM vector_top_k('chunk_embeddings_idx', vector32(?), ?) AS v
          JOIN chunk_embeddings e ON e.rowid = v.rowid
          JOIN chunks c ON c.id = e.chunk_id
          JOIN documents d ON d.id = c.document_id
          WHERE 1=1${DOC_OK}
        `,
        args: [
          Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength),
          candidateLimit,
        ],
      });

      const scored: SearchHit[] = [];
      for (const row of res.rows) {
        if (modelId && String(row.model_id) !== modelId) continue;
        const dims = Number(row.dims);
        if (dims !== queryVec.length) continue;
        const vec = blobToFloat32(row.embedding, dims);
        const sim = cosine(queryVec, vec);
        if (sim == null) continue;
        const hit = rowToHit(row as Record<string, unknown>, sim);
        if (!hitMatchesFilters(hit, filters)) continue;
        scored.push(hit);
      }
      scored.sort((a, b) => b.score - a.score);

      if (scored.length >= limit || !filtering) {
        return scored.slice(0, limit);
      }
      // ANN returned rows but filters starved the set — escalate over-fetch.
      if (res.rows.length === 0) break;
    } catch {
      break;
    }
  }

  return filtering ? bruteForceVectorSearch(db, queryVec, limit, filters, modelId) : [];
}

/** Cap how many chunks from the same document appear in the ranked list. */
export function diversifyByDocument(hits: SearchHit[], maxPerDocument: number): SearchHit[] {
  if (maxPerDocument <= 0) return hits;
  const counts = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const n = counts.get(hit.documentId) ?? 0;
    if (n >= maxPerDocument) continue;
    counts.set(hit.documentId, n + 1);
    out.push(hit);
  }
  return out;
}

export async function hybridSearch(
  db: Client,
  query: string,
  config: LocaldocConfig,
  embedder: Embedder | null,
  filters?: SearchFilters,
): Promise<SearchHit[]> {
  log.info(
    `query start qLen=${query.length} q=${JSON.stringify(query.slice(0, 80))} embedder=${embedder?.modelId ?? "none"} rerank=${config.rerank.enabled ? config.rerank.provider : "off"} filters=${hasSearchFilters(filters) ? JSON.stringify({ kinds: filters?.kinds, sources: filters?.sourceIds?.length, keywords: filters?.keywords?.length }) : "none"}`,
  );
  const ftsHits = await ftsSearch(db, query, config.search.fts_limit, filters);

  let vectorHits: SearchHit[] = [];
  if (embedder) {
    try {
      const queryVec = await embedder.embedOne(query);
      vectorHits = await vectorSearch(
        db,
        queryVec,
        config.search.vector_limit,
        filters,
        embedder.modelId,
      );
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

  // Cap before rerank — fused lists can be fts_limit+vector_limit (~80) docs.
  const rerankCap = Math.max(config.search.top_k * 3, config.search.vector_limit);
  ranked = ranked.slice(0, rerankCap);

  if (config.rerank.enabled && config.rerank.provider !== "none") {
    try {
      ranked = await rerankResults(query, ranked, config, expandHome(config.data_dir));
    } catch (err) {
      log.error(`rerank failed; returning unre-ranked hits: ${formatError(err)}`);
      await flushLog();
    }
  }

  ranked = diversifyByDocument(ranked, config.search.max_per_document);
  const out = ranked.slice(0, config.search.top_k);
  log.info(`query done hits=${out.length} (fts=${ftsHits.length} vector=${vectorHits.length})`);
  return out;
}
