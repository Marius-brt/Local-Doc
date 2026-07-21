import { join } from "node:path";
import { createCohere } from "@ai-sdk/cohere";
import { rerank } from "ai";
import type { LocaldocConfig } from "../config/schema.ts";
import { buildFetchInit } from "../crawl/fetch.ts";
import { resolveApiKey } from "../util/api-key.ts";
import { formatError, flushLog, log } from "../util/log.ts";
import type { SearchHit } from "./hybrid.ts";

export type RankedHit = SearchHit;

export async function rerankResults(
  query: string,
  hits: RankedHit[],
  config: LocaldocConfig,
): Promise<RankedHit[]> {
  if (hits.length === 0) return hits;

  if (config.rerank.provider === "cohere") {
    return rerankCohere(query, hits, config);
  }
  if (config.rerank.provider === "openai") {
    return rerankOpenAI(query, hits, config);
  }
  if (config.rerank.provider === "local") {
    return rerankLocal(query, hits, config);
  }
  return hits;
}

function optionalRerankApiKey(config: LocaldocConfig, fallbackDollarEnv: string): string | null {
  const raw = config.rerank.api_key?.trim();
  if (!raw) {
    const envName = fallbackDollarEnv.startsWith("$")
      ? fallbackDollarEnv.slice(1)
      : fallbackDollarEnv;
    if (envName && process.env[envName]) {
      return process.env[envName]!;
    }
    return null;
  }
  return resolveApiKey(raw, "Rerank");
}

function rerankUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/rerank")) return base;
  return `${base}/rerank`;
}

async function rerankCohere(
  query: string,
  hits: RankedHit[],
  config: LocaldocConfig,
): Promise<RankedHit[]> {
  const apiKey = resolveApiKey(config.rerank.api_key?.trim() || "$COHERE_API_KEY", "Cohere rerank");
  const baseURL = config.rerank.base_url?.trim() || "https://api.cohere.com/v2";
  const modelId = config.rerank.model ?? "rerank-v3.5";

  try {
    const cohere = createCohere({ apiKey, baseURL });
    const { ranking } = await rerank({
      model: cohere.reranking(modelId),
      documents: hits.map((h) => h.text),
      query,
      topN: hits.length,
    });

    return ranking
      .map((r) => {
        const hit = hits[r.originalIndex]!;
        return { ...hit, score: r.score };
      })
      .sort((a, b) => b.score - a.score);
  } catch (err) {
    log.error(`cohere rerank failed (model=${modelId} base_url=${baseURL}): ${formatError(err)}`);
    await flushLog();
    throw err;
  }
}

/**
 * OpenAI-compatible / llama.cpp / TEI-style rerank:
 * POST {base_url}/rerank  { query, documents, model?, top_n? }
 * Response: { results: [{ index, relevance_score }] }
 */
async function rerankOpenAI(
  query: string,
  hits: RankedHit[],
  config: LocaldocConfig,
): Promise<RankedHit[]> {
  const baseURL = config.rerank.base_url?.trim();
  if (!baseURL) {
    throw new Error(
      "rerank.base_url is required when provider is openai (e.g. http://127.0.0.1:8080)",
    );
  }
  const modelId = config.rerank.model ?? undefined;
  const url = rerankUrl(baseURL);
  const apiKey = optionalRerankApiKey(config, "$OPENAI_API_KEY");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body: Record<string, unknown> = {
    query,
    documents: hits.map((h) => h.text),
    top_n: hits.length,
  };
  if (modelId) body.model = modelId;

  try {
    const init = buildFetchInit(config, {
      url,
      headers,
      timeoutMs: Math.max(config.crawl.timeout_ms, 60_000),
    });
    const res = await fetch(url, {
      ...init,
      method: "POST",
      headers: { ...(init.headers as Record<string, string>), ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 400)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 400)}`);
    }

    const results = extractOpenAIRerankResults(parsed);
    if (results.length === 0) {
      throw new Error(`No rerank results in response from ${url}: ${text.slice(0, 400)}`);
    }

    const ranked: RankedHit[] = [];
    for (const row of results) {
      const hit = hits[row.index];
      if (!hit) continue;
      ranked.push({ ...hit, score: row.score });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.length > 0 ? ranked : hits;
  } catch (err) {
    log.error(
      `openai rerank failed (model=${modelId ?? "default"} base_url=${baseURL}): ${formatError(err)}`,
    );
    await flushLog();
    throw err;
  }
}

function extractOpenAIRerankResults(parsed: unknown): Array<{ index: number; score: number }> {
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  const raw = (obj.results ?? obj.data) as unknown;
  if (!Array.isArray(raw)) return [];

  const out: Array<{ index: number; score: number }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const index = Number(row.index ?? row.document_index);
    const score = Number(row.relevance_score ?? row.score ?? row.relevanceScore);
    if (!Number.isFinite(index) || !Number.isFinite(score)) continue;
    out.push({ index, score });
  }
  return out;
}

async function rerankLocal(
  query: string,
  hits: RankedHit[],
  config: LocaldocConfig,
): Promise<RankedHit[]> {
  const modelId = config.rerank.model ?? "Xenova/ms-marco-MiniLM-L-6-v2";
  const dataDir = join(process.env.HOME ?? ".", ".localdoc");
  const { ensureOnnxNatives } = await import("../embed/onnx-natives.ts");
  await ensureOnnxNatives(dataDir);
  const { pipeline, env } = await import("@huggingface/transformers");
  if (!env.cacheDir) {
    env.cacheDir = join(dataDir, "models");
  }

  type Ranker = (
    pairs: { text: string; text_pair: string }[],
  ) => Promise<{ data: Float32Array } | Float32Array | number[]>;

  let ranker: Ranker;
  try {
    ranker = (await pipeline("text-classification", modelId)) as Ranker;
  } catch {
    return hits;
  }

  const scored: RankedHit[] = [];
  for (const hit of hits) {
    try {
      const out = await ranker([{ text: query, text_pair: hit.text }]);
      let score = hit.score;
      if (out && typeof out === "object" && "data" in out) {
        score = Number((out as { data: Float32Array }).data[0] ?? score);
      } else if (Array.isArray(out)) {
        const first = out[0] as { score?: number } | number | undefined;
        if (typeof first === "number") score = first;
        else if (first && typeof first === "object" && "score" in first) {
          score = Number(first.score);
        }
      }
      scored.push({ ...hit, score });
    } catch {
      scored.push(hit);
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
