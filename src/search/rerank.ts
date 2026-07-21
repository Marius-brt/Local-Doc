import { join } from "node:path";
import { createCohere } from "@ai-sdk/cohere";
import { rerank } from "ai";
import type { LocaldocConfig } from "../config/schema.ts";
import { resolveApiKey } from "../util/api-key.ts";
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
  if (config.rerank.provider === "local") {
    return rerankLocal(query, hits, config);
  }
  return hits;
}

async function rerankCohere(
  query: string,
  hits: RankedHit[],
  config: LocaldocConfig,
): Promise<RankedHit[]> {
  const cohereCfg = config.rerank.cohere;
  const apiKey = resolveApiKey(cohereCfg?.api_key ?? "$COHERE_API_KEY", "Cohere rerank");
  const baseURL = cohereCfg?.base_url ?? "https://api.cohere.com/v2";

  const cohere = createCohere({ apiKey, baseURL });
  const modelId = config.rerank.model ?? "rerank-v3.5";

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
