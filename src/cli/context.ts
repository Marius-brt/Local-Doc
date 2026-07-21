import type { LoadedConfig } from "../config/load.ts";
import { loadConfig } from "../config/load.ts";
import { getDb } from "../db/client.ts";
import { log } from "../util/log.ts";

export interface Ctx {
  loaded: LoadedConfig;
}

export async function createCtx(configPath?: string): Promise<Ctx> {
  const loaded = await loadConfig(configPath);
  await getDb(loaded.dataDir);
  log.info(`loaded config=${loaded.configPath} data_dir=${loaded.dataDir}`);
  return { loaded };
}

export function globalFlags(args: { config?: string }) {
  return args.config;
}
