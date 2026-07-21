import type { Client } from "@libsql/client";
import { shortId } from "../util/hash.ts";
import { nowIso } from "./client.ts";

export interface DocumentRow {
  id: string;
  source_id: string;
  uri: string;
  title: string | null;
  content_hash: string | null;
  extracted_path: string | null;
  status: string;
  error: string | null;
  meta_json: string;
}

export async function upsertDocument(
  db: Client,
  input: {
    sourceId: string;
    uri: string;
    title?: string;
    contentHash?: string;
    extractedPath?: string;
    status?: string;
    error?: string | null;
    meta?: Record<string, unknown>;
  },
): Promise<DocumentRow> {
  const id = shortId(`${input.sourceId}:${input.uri}`);
  const ts = nowIso();
  await db.execute({
    sql: `INSERT INTO documents (id, source_id, uri, title, content_hash, extracted_path, status, error, meta_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_id, uri) DO UPDATE SET
            title=COALESCE(excluded.title, documents.title),
            content_hash=COALESCE(excluded.content_hash, documents.content_hash),
            extracted_path=COALESCE(excluded.extracted_path, documents.extracted_path),
            status=excluded.status,
            error=excluded.error,
            meta_json=excluded.meta_json,
            updated_at=excluded.updated_at`,
    args: [
      id,
      input.sourceId,
      input.uri,
      input.title ?? null,
      input.contentHash ?? null,
      input.extractedPath ?? null,
      input.status ?? "ok",
      input.error ?? null,
      JSON.stringify(input.meta ?? {}),
      ts,
      ts,
    ],
  });
  return {
    id,
    source_id: input.sourceId,
    uri: input.uri,
    title: input.title ?? null,
    content_hash: input.contentHash ?? null,
    extracted_path: input.extractedPath ?? null,
    status: input.status ?? "ok",
    error: input.error ?? null,
    meta_json: JSON.stringify(input.meta ?? {}),
  };
}

function rowToDocument(row: Record<string, unknown>): DocumentRow {
  return {
    id: String(row.id),
    source_id: String(row.source_id),
    uri: String(row.uri),
    title: row.title == null ? null : String(row.title),
    content_hash: row.content_hash == null ? null : String(row.content_hash),
    extracted_path: row.extracted_path == null ? null : String(row.extracted_path),
    status: String(row.status),
    error: row.error == null ? null : String(row.error),
    meta_json: String(row.meta_json ?? "{}"),
  };
}

export async function getDocumentByUri(
  db: Client,
  sourceId: string,
  uri: string,
): Promise<DocumentRow | null> {
  const res = await db.execute({
    sql: "SELECT * FROM documents WHERE source_id = ? AND uri = ?",
    args: [sourceId, uri],
  });
  const row = res.rows[0];
  if (!row) return null;
  return rowToDocument(row as Record<string, unknown>);
}

export function documentExtractorVersion(doc: DocumentRow): number | null {
  try {
    const meta = JSON.parse(doc.meta_json || "{}") as { extractor_version?: unknown };
    const v = meta.extractor_version;
    return typeof v === "number" ? v : typeof v === "string" ? Number(v) || null : null;
  } catch {
    return null;
  }
}

export async function listDocumentUris(
  db: Client,
  sourceId: string,
): Promise<Array<{ id: string; uri: string }>> {
  const res = await db.execute({
    sql: "SELECT id, uri FROM documents WHERE source_id = ?",
    args: [sourceId],
  });
  return res.rows.map((r) => ({ id: String(r.id), uri: String(r.uri) }));
}

export async function deleteDocument(db: Client, documentId: string): Promise<void> {
  await deleteChunksForDocument(db, documentId);
  await db.execute({ sql: "DELETE FROM documents WHERE id = ?", args: [documentId] });
}

/** Remove documents whose URI is not in `keepUris`. */
export async function pruneDocumentsNotIn(
  db: Client,
  sourceId: string,
  keepUris: Set<string>,
): Promise<number> {
  const docs = await listDocumentUris(db, sourceId);
  let removed = 0;
  for (const doc of docs) {
    if (keepUris.has(doc.uri)) continue;
    await deleteDocument(db, doc.id);
    removed++;
  }
  return removed;
}

export async function deleteChunksForDocument(db: Client, documentId: string): Promise<void> {
  await db.execute({
    sql: "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
    args: [documentId],
  });
  await db.execute({
    sql: "DELETE FROM chunks WHERE document_id = ?",
    args: [documentId],
  });
}

export async function insertChunks(
  db: Client,
  chunks: Array<{
    id: string;
    documentId: string;
    sourceId: string;
    chunkIndex: number;
    text: string;
    heading?: string | null;
    sectionPath?: string | null;
    title?: string | null;
    startOffset?: number | null;
    endOffset?: number | null;
    contentHash: string;
    meta?: Record<string, unknown>;
  }>,
): Promise<void> {
  const ts = nowIso();
  for (const c of chunks) {
    await db.execute({
      sql: `INSERT INTO chunks (id, document_id, source_id, chunk_index, text, heading, section_path, title, start_offset, end_offset, content_hash, meta_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        c.id,
        c.documentId,
        c.sourceId,
        c.chunkIndex,
        c.text,
        c.heading ?? null,
        c.sectionPath ?? null,
        c.title ?? null,
        c.startOffset ?? null,
        c.endOffset ?? null,
        c.contentHash,
        JSON.stringify(c.meta ?? {}),
        ts,
      ],
    });
  }
}

export async function insertEmbedding(
  db: Client,
  chunkId: string,
  modelId: string,
  embedding: Float32Array,
): Promise<void> {
  const ts = nowIso();
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  await db.execute({
    sql: `INSERT INTO chunk_embeddings (chunk_id, model_id, dims, embedding, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(chunk_id) DO UPDATE SET
            model_id=excluded.model_id,
            dims=excluded.dims,
            embedding=excluded.embedding,
            created_at=excluded.created_at`,
    args: [chunkId, modelId, embedding.length, buf, ts],
  });
}

export async function countStats(db: Client): Promise<{
  sources: number;
  documents: number;
  chunks: number;
  embeddings: number;
}> {
  const [s, d, c, e] = await Promise.all([
    db.execute("SELECT COUNT(*) AS n FROM sources"),
    db.execute("SELECT COUNT(*) AS n FROM documents"),
    db.execute("SELECT COUNT(*) AS n FROM chunks"),
    db.execute("SELECT COUNT(*) AS n FROM chunk_embeddings"),
  ]);
  return {
    sources: Number(s.rows[0]?.n ?? 0),
    documents: Number(d.rows[0]?.n ?? 0),
    chunks: Number(c.rows[0]?.n ?? 0),
    embeddings: Number(e.rows[0]?.n ?? 0),
  };
}
