import type { Client } from "@libsql/client";

async function getMeta(db: Client, key: string): Promise<string | null> {
  try {
    const res = await db.execute({
      sql: "SELECT value FROM localdoc_meta WHERE key = ? LIMIT 1",
      args: [key],
    });
    return res.rows[0] ? String(res.rows[0].value) : null;
  } catch {
    return null;
  }
}

async function setMeta(db: Client, key: string, value: string): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS localdoc_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `);
  await db.execute({
    sql: `INSERT INTO localdoc_meta (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

/** Parse `F32_BLOB(1024)` → 1024; returns null for plain BLOB / unknown. */
function parseF32BlobDims(type: string): number | null {
  const m = /F32_BLOB\s*\(\s*(\d+)\s*\)/i.exec(type);
  return m ? Number(m[1]) : null;
}

async function columnType(db: Client, table: string, column: string): Promise<string | null> {
  const res = await db.execute(`PRAGMA table_info(${table})`);
  for (const row of res.rows) {
    if (String(row.name) === column) {
      return String(row.type ?? "");
    }
  }
  return null;
}

async function dropVectorArtifacts(db: Client): Promise<void> {
  for (const sql of [
    "DROP INDEX IF EXISTS chunk_embeddings_idx",
    "DROP TABLE IF EXISTS chunk_embeddings_idx_shadow",
    "DELETE FROM libsql_vector_meta_shadow WHERE name = 'chunk_embeddings_idx'",
  ]) {
    try {
      await db.execute(sql);
    } catch {
      // ignore
    }
  }
}

/**
 * Ensure `chunk_embeddings.embedding` is `F32_BLOB(dims)` and the vector index
 * matches. libSQL locks vector dimensionality in the column type — changing
 * models (e.g. 1024 → 256 for potion-base-8M) requires rebuilding the table.
 */
export async function ensureVectorIndex(db: Client, dims: number): Promise<void> {
  if (dims <= 0) return;

  const colType = await columnType(db, "chunk_embeddings", "embedding");
  const colDims = colType ? parseF32BlobDims(colType) : null;
  const metaDims = await getMeta(db, "vector_dims");
  const needsRebuild =
    colDims !== dims || metaDims !== String(dims) || colType?.toUpperCase() === "BLOB";

  if (!needsRebuild) {
    try {
      await db.execute(`
        CREATE INDEX IF NOT EXISTS chunk_embeddings_idx
        ON chunk_embeddings (libsql_vector_idx(embedding))
      `);
    } catch {
      // optional
    }
    return;
  }

  console.error(
    `[localdoc] rebuilding vector table for ${dims}-d embeddings (was ${colType ?? "unknown"})`,
  );

  await rebuildVectorTable(db, dims, { preserveMatchingRows: true });
}

/**
 * Recreate `chunk_embeddings` as `F32_BLOB(dims)` and recreate the vector index.
 * Used when switching embedding models so the index matches the new dimension.
 */
export async function rebuildVectorTable(
  db: Client,
  dims: number,
  opts: { preserveMatchingRows?: boolean } = {},
): Promise<void> {
  if (dims <= 0) {
    throw new Error(`invalid embedding dimensions: ${dims}`);
  }

  const preserve = opts.preserveMatchingRows ?? false;
  await dropVectorArtifacts(db);

  if (preserve) {
    await db.executeMultiple(`
      CREATE TABLE chunk_embeddings_new (
        chunk_id TEXT PRIMARY KEY NOT NULL,
        model_id TEXT NOT NULL,
        dims INTEGER NOT NULL,
        embedding F32_BLOB(${dims}),
        created_at TEXT NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
      );
      INSERT INTO chunk_embeddings_new (chunk_id, model_id, dims, embedding, created_at)
        SELECT chunk_id, model_id, dims, embedding, created_at
        FROM chunk_embeddings
        WHERE dims = ${dims};
      DROP TABLE chunk_embeddings;
      ALTER TABLE chunk_embeddings_new RENAME TO chunk_embeddings;
    `);
  } else {
    await db.executeMultiple(`
      DROP TABLE IF EXISTS chunk_embeddings;
      CREATE TABLE chunk_embeddings (
        chunk_id TEXT PRIMARY KEY NOT NULL,
        model_id TEXT NOT NULL,
        dims INTEGER NOT NULL,
        embedding F32_BLOB(${dims}),
        created_at TEXT NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
      );
    `);
  }

  try {
    await db.execute(`
      CREATE INDEX chunk_embeddings_idx
      ON chunk_embeddings (libsql_vector_idx(embedding))
    `);
  } catch {
    // vector index optional — BLOB storage still works for brute-force search
  }

  await setMeta(db, "vector_dims", String(dims));
}

/** Current stored vector dimensionality, if known. */
export async function getVectorDims(db: Client): Promise<number | null> {
  const meta = await getMeta(db, "vector_dims");
  if (meta && /^\d+$/.test(meta)) return Number(meta);
  const colType = await columnType(db, "chunk_embeddings", "embedding");
  return colType ? parseF32BlobDims(colType) : null;
}
