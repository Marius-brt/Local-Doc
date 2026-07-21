import { createHash, randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { MIGRATIONS } from "./migrations.ts";

async function tableExists(client: Client, name: string): Promise<boolean> {
  const res = await client.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1`,
    args: [name],
  });
  return res.rows.length > 0;
}

async function recordApplied(client: Client, name: string, sql: string): Promise<void> {
  const checksum = createHash("sha256").update(sql).digest("hex");
  await client.execute({
    sql: `INSERT INTO _prisma_migrations
      (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
      VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
    args: [randomUUID(), checksum, name],
  });
}

/** FTS pieces are IF NOT EXISTS — safe to run on legacy DBs that predate Prisma. */
async function ensureFts(client: Client): Promise<void> {
  await client.executeMultiple(`
CREATE VIRTUAL TABLE IF NOT EXISTS "chunks_fts" USING fts5(
  text,
  heading,
  section_path,
  content='chunks',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading, section_path)
  VALUES (new.rowid, new.text, new.heading, new.section_path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading, section_path)
  VALUES ('delete', old.rowid, old.text, old.heading, old.section_path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading, section_path)
  VALUES ('delete', old.rowid, old.text, old.heading, old.section_path);
  INSERT INTO chunks_fts(rowid, text, heading, section_path)
  VALUES (new.rowid, new.text, new.heading, new.section_path);
END;
`);
}

function isAlreadyExistsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(msg);
}

/**
 * Apply Prisma migration SQL at runtime (no prisma CLI required).
 * Tracks applied migrations in `_prisma_migrations`.
 *
 * SQL is imported from prisma/migrations via Bun's text loader so the same
 * files ship inside the compiled binary — no duplicated string blobs.
 *
 * Legacy DBs created before Prisma are baselined: if `sources` already exists
 * and no migrations are recorded, the init migration is marked applied
 * without re-running CREATE TABLE.
 */
export async function applyPrismaMigrations(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS _prisma_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      finished_at DATETIME,
      migration_name TEXT NOT NULL,
      logs TEXT,
      rolled_back_at DATETIME,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  const applied = await client.execute(
    "SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL",
  );
  const appliedNames = new Set(applied.rows.map((r) => String(r.migration_name)));

  const legacyBaseline = appliedNames.size === 0 && (await tableExists(client, "sources"));
  const initName = MIGRATIONS[0]?.name;

  for (const { name, sql } of MIGRATIONS) {
    if (appliedNames.has(name)) continue;

    if (legacyBaseline && name === initName) {
      await recordApplied(client, name, sql);
      await ensureFts(client);
      appliedNames.add(name);
      continue;
    }

    try {
      await client.executeMultiple(sql);
      await recordApplied(client, name, sql);
      appliedNames.add(name);
    } catch (err) {
      if (isAlreadyExistsError(err) && (await tableExists(client, "sources"))) {
        // Partial / pre-Prisma schema: treat as applied and ensure FTS.
        await recordApplied(client, name, sql);
        await ensureFts(client);
        appliedNames.add(name);
        continue;
      }
      throw err;
    }
  }

  // Vector index is created lazily in ensureVectorIndex once embedding dims are known.
  // Creating it here without data can lock the wrong dimensionality.
}
