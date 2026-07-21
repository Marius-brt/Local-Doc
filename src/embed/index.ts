import { join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed as aiEmbed } from "ai";
import type { LocaldocConfig } from "../config/schema.ts";
import { ensureModel2VecBinary } from "./model2vec-bin.ts";
import { DEFAULT_MODEL_ID, ensureModel2VecWeights } from "./model2vec-weights.ts";
import { ensureOnnxNatives } from "./onnx-natives.ts";

export interface Embedder {
  modelId: string;
  dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  embedOne(text: string): Promise<Float32Array>;
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

async function encodeWithModel2VecSidecar(
  bin: string,
  modelDir: string,
  texts: string[],
): Promise<{ dims: number; embeddings: Float32Array[] }> {
  const proc = Bun.spawn([bin, "--model", modelDir], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify({ texts }));
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let parsed: SidecarResponse;
  try {
    parsed = JSON.parse(stdout) as SidecarResponse;
  } catch {
    throw new Error(
      `model2vec sidecar returned invalid JSON (exit ${exitCode}): ${stdout || stderr}`,
    );
  }
  if (parsed.error || exitCode !== 0) {
    throw new Error(parsed.error ?? (stderr || `model2vec sidecar exited ${exitCode}`));
  }
  const dims = parsed.dims ?? parsed.embeddings?.[0]?.length ?? 0;
  const embeddings = (parsed.embeddings ?? []).map((row) => Float32Array.from(row));
  return { dims, embeddings };
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
    async embed(texts: string[]) {
      const loaded = await loadModel2VecSidecar(configuredModel, dataDir);
      resolvedModel = loaded.modelId;
      dims = loaded.dims;
      if (texts.length === 0) {
        return [];
      }
      const out: Float32Array[] = [];
      const batchSize = 64;
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const { embeddings, dims: d } = await encodeWithModel2VecSidecar(
          loaded.bin,
          loaded.modelDir,
          batch,
        );
        dims = d;
        out.push(...embeddings);
      }
      return out;
    },
    async embedOne(text: string) {
      const [v] = await this.embed([text]);
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
  const oc = config.embeddings.openai_compatible;
  if (!oc) {
    throw new Error(
      "embeddings.openai_compatible config is required when provider is openai_compatible",
    );
  }
  const apiKey = process.env[oc.api_key_env];
  if (!apiKey) {
    throw new Error(`Missing API key env var ${oc.api_key_env} for OpenAI-compatible embeddings`);
  }
  const provider = createOpenAICompatible({
    name: "openai_compatible",
    baseURL: oc.base_url,
    apiKey,
  });
  const model = provider.embeddingModel(oc.model);
  let dims = 0;

  return {
    get modelId() {
      return `openai_compatible:${oc.model}`;
    },
    get dims() {
      return dims;
    },
    async embed(texts: string[]) {
      const out: Float32Array[] = [];
      for (const text of texts) {
        const { embedding } = await aiEmbed({
          model,
          value: text,
        });
        dims = embedding.length;
        out.push(Float32Array.from(embedding));
      }
      return out;
    },
    async embedOne(text: string) {
      const [v] = await this.embed([text]);
      return v!;
    },
  };
}

export function createEmbedder(config: LocaldocConfig, dataDir: string): Embedder {
  if (config.embeddings.provider === "openai_compatible") {
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
    if (config.embeddings.provider === "openai_compatible") {
      return createOpenAIEmbedder(config);
    }
    return createModel2VecEmbedder(config, dataDir);
  } catch (err) {
    console.error(
      `[localdoc] embeddings unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
