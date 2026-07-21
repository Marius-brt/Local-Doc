import type { Client } from "@libsql/client";
import { shortId } from "../util/hash.ts";
import { nowIso } from "./client.ts";

export type SourceKind = "web" | "folder" | "github";

export interface SourceRow {
  id: string;
  kind: SourceKind;
  root_uri: string;
  title: string | null;
  strategy: string | null;
  status: string;
  meta_json: string;
  created_at: string;
  updated_at: string;
}

export async function upsertSource(
  db: Client,
  input: {
    kind: SourceKind;
    rootUri: string;
    title?: string;
    strategy?: string;
    status?: string;
    meta?: Record<string, unknown>;
  },
): Promise<SourceRow> {
  const id = shortId(input.rootUri);
  const ts = nowIso();
  const existing = await db.execute({
    sql: "SELECT * FROM sources WHERE root_uri = ?",
    args: [input.rootUri],
  });
  if (existing.rows.length > 0) {
    await db.execute({
      sql: `UPDATE sources SET kind=?, title=COALESCE(?, title), strategy=COALESCE(?, strategy),
            status=COALESCE(?, status), meta_json=?, updated_at=? WHERE id=?`,
      args: [
        input.kind,
        input.title ?? null,
        input.strategy ?? null,
        input.status ?? null,
        JSON.stringify(input.meta ?? {}),
        ts,
        id,
      ],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO sources (id, kind, root_uri, title, strategy, status, meta_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.kind,
        input.rootUri,
        input.title ?? null,
        input.strategy ?? null,
        input.status ?? "pending",
        JSON.stringify(input.meta ?? {}),
        ts,
        ts,
      ],
    });
  }
  const row = await getSource(db, id);
  if (!row) throw new Error(`Failed to upsert source ${id}`);
  return row;
}

export async function getSource(db: Client, idOrUri: string): Promise<SourceRow | null> {
  const byId = await db.execute({
    sql: "SELECT * FROM sources WHERE id = ? OR root_uri = ?",
    args: [idOrUri, idOrUri],
  });
  if (byId.rows[0]) return rowToSource(byId.rows[0]);
  return null;
}

export async function listSources(db: Client): Promise<SourceRow[]> {
  const res = await db.execute("SELECT * FROM sources ORDER BY updated_at DESC");
  return res.rows.map(rowToSource);
}

export async function removeSource(db: Client, idOrUri: string): Promise<boolean> {
  const src = await getSource(db, idOrUri);
  if (!src) return false;
  await db.execute({
    sql: "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id = ?)",
    args: [src.id],
  });
  await db.execute({ sql: "DELETE FROM chunks WHERE source_id = ?", args: [src.id] });
  await db.execute({ sql: "DELETE FROM documents WHERE source_id = ?", args: [src.id] });
  await db.execute({ sql: "DELETE FROM ingest_errors WHERE source_id = ?", args: [src.id] });
  await db.execute({ sql: "DELETE FROM ingest_runs WHERE source_id = ?", args: [src.id] });
  await db.execute({ sql: "DELETE FROM sources WHERE id = ?", args: [src.id] });
  return true;
}

export async function removeAllSources(db: Client): Promise<number> {
  const sources = await listSources(db);
  for (const s of sources) {
    await removeSource(db, s.id);
  }
  return sources.length;
}

function rowToSource(row: Record<string, unknown>): SourceRow {
  return {
    id: String(row.id),
    kind: String(row.kind) as SourceKind,
    root_uri: String(row.root_uri),
    title: row.title == null ? null : String(row.title),
    strategy: row.strategy == null ? null : String(row.strategy),
    status: String(row.status),
    meta_json: String(row.meta_json ?? "{}"),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
