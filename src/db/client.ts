import { type Client, createClient } from "@libsql/client";
import { dbPath } from "../config/load.ts";
import { applyPrismaMigrations } from "./migrate.ts";
import { wrapClientWithBusyRetry } from "./retry.ts";

let clientSingleton: Client | null = null;
let clientDataDir: string | null = null;

export async function getDb(dataDir: string): Promise<Client> {
  if (clientSingleton && clientDataDir === dataDir) {
    return clientSingleton;
  }
  if (clientSingleton) {
    clientSingleton.close();
  }
  const path = dbPath(dataDir);
  const raw = createClient({ url: `file:${path}` });
  await raw.executeMultiple(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=8000;
    PRAGMA synchronous=NORMAL;
  `);
  await applyPrismaMigrations(raw);
  const client = wrapClientWithBusyRetry(raw);
  clientSingleton = client;
  clientDataDir = dataDir;
  return client;
}

export function closeDb(): void {
  if (clientSingleton) {
    clientSingleton.close();
    clientSingleton = null;
    clientDataDir = null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
