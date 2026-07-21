import type { LoadedConfig } from "../config/load.ts";
import { loadConfig } from "../config/load.ts";
import { getDb } from "../db/client.ts";

export interface Ctx {
  loaded: LoadedConfig;
}

export async function createCtx(configPath?: string): Promise<Ctx> {
  const loaded = await loadConfig(configPath);
  await getDb(loaded.dataDir);
  return { loaded };
}

export function globalFlags(args: { config?: string }) {
  return args.config;
}
