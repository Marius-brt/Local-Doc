import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { defaultDataDir, expandHome, resolveConfigPath } from "../util/paths.ts";
import { ConfigSchema, type LocaldocConfig } from "./schema.ts";

export type { LocaldocConfig };

const DEFAULT_CONFIG_YAML = `# localdoc configuration
# See https://github.com/Marius-brt/Local-Doc for docs

data_dir: ~/.localdoc

embeddings:
  provider: model2vec
  model: minishlab/potion-base-8M
  # openai_compatible:
  #   base_url: https://api.openai.com/v1
  #   api_key_env: OPENAI_API_KEY
  #   model: text-embedding-3-small

rerank:
  enabled: false
  provider: none
  model: null
  # cohere:
  #   api_key_env: COHERE_API_KEY

search:
  rrf_k: 60
  fts_limit: 40
  vector_limit: 40
  top_k: 12
  budget_tokens: 2400

chunking:
  chunk_size: 512
  min_characters: 24
  table_rows: 3

crawl:
  max_pages: 500
  concurrency: 4
  timeout_ms: 30000
  playwright: auto
  respect_robots: true
  headers: {}

http:
  # One proxy for both http:// and https:// targets
  proxy: null
  # proxy: http://127.0.0.1:7890
  headers: {}
  retries: 3
  # Set false to allow self-signed / intercepting TLS (insecure)
  reject_unauthorized: true
`;

export interface LoadedConfig {
  config: LocaldocConfig;
  configPath: string;
  dataDir: string;
  created: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(overridePath?: string): Promise<LoadedConfig> {
  const configPath = resolveConfigPath(overridePath);
  let created = false;
  let raw: unknown = {};

  if (!(await exists(configPath))) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, DEFAULT_CONFIG_YAML, "utf8");
    created = true;
    raw = parseYaml(DEFAULT_CONFIG_YAML) ?? {};
  } else {
    const text = await readFile(configPath, "utf8");
    raw = parseYaml(text) ?? {};
  }

  const config = ConfigSchema.parse(raw);
  const dataDir = expandHome(config.data_dir || defaultDataDir());
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(dataDir, "models"), { recursive: true });
  await mkdir(join(dataDir, "cache"), { recursive: true });
  await mkdir(join(dataDir, "extracted"), { recursive: true });
  await mkdir(join(dataDir, "browsers"), { recursive: true });

  return { config, configPath, dataDir, created };
}

export async function saveConfig(configPath: string, config: LocaldocConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, stringifyYaml(config), "utf8");
}

export function dbPath(dataDir: string): string {
  return join(dataDir, "index.db");
}
