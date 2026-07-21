import { join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed as aiEmbed, embedMany } from "ai";
import type { LocaldocConfig } from "../config/schema.ts";
import { resolveApiKey } from "../util/api-key.ts";
import { log } from "../util/log.ts";
import { ensureModel2VecBinary } from "./model2vec-bin.ts";
import { DEFAULT_MODEL_ID, ensureModel2VecWeights } from "./model2vec-weights.ts";
import { ensureOnnxNatives } from "./onnx-natives.ts";

export interface Embedder {
  modelId: string;
  dims: number;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  embedOne(text: string, signal?: AbortSignal): Promise<Float32Array>;
}

type FeatureExtractor = (
  texts: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ tolist: () => number[][] | number[] }>;

let model2vecCache: {
  modelId: string;
  modelDir: string;
  bin: string;
  dims: number;
} | null = null;

let transformersCache: {
  modelId: string;
  extractor: FeatureExtractor;
  dims: number;
} | null = null;

interface SidecarResponse {
  dims?: number;
  embeddings?: number[][];
  error?: string;
}

function throwIfEmbedAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Cancelled");
    err.name = "AbortError";
    throw err;
  }
}

async function encodeWithModel2VecSidecar(
  bin: string,
  modelDir: string,
  texts: string[],
  signal?: AbortSignal,
): Promise<{ dims: number; embeddings: Float32Array[] }> {
  throwIfEmbedAborted(signal);
  const proc = Bun.spawn([bin, "--model", modelDir], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      throwIfEmbedAborted(signal);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    proc.stdin.write(JSON.stringify({ texts }));
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    throwIfEmbedAborted(signal);
    let parsed: SidecarResponse;
    try {
      parsed = JSON.parse(stdout) as SidecarResponse;
    } catch {
      throwIfEmbedAborted(signal);
      const preview = (stdout || stderr || "(empty)").slice(0, 500);
      const msg = `model2vec sidecar returned invalid JSON (exit ${exitCode}): ${preview}`;
      log.error(msg);
      throw new Error(msg);
    }
    if (parsed.error || exitCode !== 0) {
      throwIfEmbedAborted(signal);
      throw new Error(parsed.error ?? (stderr || `model2vec sidecar exited ${exitCode}`));
    }
    const dims = parsed.dims ?? parsed.embeddings?.[0]?.length ?? 0;
    const embeddings = (parsed.embeddings ?? []).map((row) => Float32Array.from(row));
    return { dims, embeddings };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function loadModel2VecSidecar(
  modelId: string,
  dataDir: string,
): Promise<{ modelId: string; modelDir: string; bin: string; dims: number }> {
  if (model2vecCache && model2vecCache.modelId === modelId) {
    return model2vecCache;
  }
  const bin = await ensureModel2VecBinary(dataDir);
  const { modelId: resolvedId, modelDir } = await ensureModel2VecWeights(dataDir, modelId);
  const probe = await encodeWithModel2VecSidecar(bin, modelDir, ["hello"]);
  model2vecCache = {
    modelId: resolvedId,
    modelDir,
    bin,
    dims: probe.dims,
  };
  return model2vecCache;
}

function createModel2VecEmbedder(config: LocaldocConfig, dataDir: string): Embedder {
  const configuredModel = config.embeddings.model || DEFAULT_MODEL_ID;
  let resolvedModel = configuredModel;
  let dims = 0;

  return {
    get modelId() {
      return resolvedModel;
    },
    get dims() {
      return dims;
    },
    async embed(texts: string[], signal?: AbortSignal) {
      throwIfEmbedAborted(signal);
      const loaded = await loadModel2VecSidecar(configuredModel, dataDir);
      resolvedModel = loaded.modelId;
      dims = loaded.dims;
      if (texts.length === 0) {
        return [];
      }
      const out: Float32Array[] = [];
      const batchSize = Math.max(1, config.embeddings.batch_size ?? 20);
      for (let i = 0; i < texts.length; i += batchSize) {
        throwIfEmbedAborted(signal);
        const batch = texts.slice(i, i + batchSize);
        const { embeddings, dims: d } = await encodeWithModel2VecSidecar(
          loaded.bin,
          loaded.modelDir,
          batch,
          signal,
        );
        dims = d;
        out.push(...embeddings);
      }
      return out;
    },
    async embedOne(text: string, signal?: AbortSignal) {
      const [v] = await this.embed([text], signal);
      return v!;
    },
  };
}

/** Transformers.js feature-extraction (bundled for local rerank / optional use). */
export async function loadTransformersExtractor(
  modelId: string,
  dataDir: string,
): Promise<{ extractor: FeatureExtractor; dims: number; modelId: string }> {
  if (transformersCache && transformersCache.modelId === modelId) {
    return transformersCache;
  }
  await ensureOnnxNatives(dataDir);
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = join(dataDir, "models");
  env.allowLocalModels = true;
  const extractor = (await pipeline("feature-extraction", modelId)) as FeatureExtractor;
  const probe = await extractor("hello", { pooling: "mean", normalize: true });
  const list = probe.tolist();
  const vec = Array.isArray(list[0]) ? (list as number[][])[0]! : (list as number[]);
  transformersCache = { modelId, extractor, dims: vec.length };
  return transformersCache;
}

function createOpenAIEmbedder(config: LocaldocConfig): Embedder {
  const oc = config.embeddings.openai;
  if (!oc) {
    throw new Error("embeddings.openai config is required when provider is openai");
  }
  const modelId = config.embeddings.model || "text-embedding-3-small";
  const apiKey = resolveApiKey(oc.api_key, "OpenAI embeddings");
  const provider = createOpenAICompatible({
    name: "openai",
    baseURL: oc.base_url,
    apiKey,
  });
  const model = provider.embeddingModel(modelId);
  let dims = 0;

  return {
    get modelId() {
      return `openai:${modelId}`;
    },
    get dims() {
      return dims;
    },
    async embed(texts: string[], signal?: AbortSignal) {
      throwIfEmbedAborted(signal);
      if (texts.length === 0) return [];
      const out: Float32Array[] = [];
      const batchSize = Math.max(1, config.embeddings.batch_size ?? 20);
      for (let i = 0; i < texts.length; i += batchSize) {
        throwIfEmbedAborted(signal);
        const batch = texts.slice(i, i + batchSize);
        if (batch.length === 1) {
          const { embedding } = await aiEmbed({
            model,
            value: batch[0]!,
            abortSignal: signal,
          });
          dims = embedding.length;
          out.push(Float32Array.from(embedding));
        } else {
          const { embeddings } = await embedMany({
            model,
            values: batch,
            abortSignal: signal,
          });
          for (const embedding of embeddings) {
            dims = embedding.length;
            out.push(Float32Array.from(embedding));
          }
        }
      }
      return out;
    },
    async embedOne(text: string, signal?: AbortSignal) {
      const [v] = await this.embed([text], signal);
      return v!;
    },
  };
}

export function createEmbedder(config: LocaldocConfig, dataDir: string): Embedder {
  if (config.embeddings.provider === "openai") {
    return createOpenAIEmbedder(config);
  }
  return createModel2VecEmbedder(config, dataDir);
}

/** Try to create an embedder; return null if configuration is invalid. */
export async function tryCreateEmbedder(
  config: LocaldocConfig,
  dataDir: string,
): Promise<Embedder | null> {
  try {
    if (config.embeddings.provider === "openai") {
      return createOpenAIEmbedder(config);
    }
    return createModel2VecEmbedder(config, dataDir);
  } catch (err) {
    log.error(`embeddings unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
