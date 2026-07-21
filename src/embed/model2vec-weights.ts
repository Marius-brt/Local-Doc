import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../util/log.ts";

const DEFAULT_MODEL_ID = "minishlab/potion-base-8M";

const REQUIRED_FILES = ["config.json", "tokenizer.json", "model.safetensors"] as const;

function modelCacheDir(dataDir: string, modelId: string): string {
  const safe = modelId.replace(/[^\w.-]+/g, "__");
  return join(dataDir, "models", "model2vec", safe);
}

function hfResolveUrl(modelId: string, file: string): string {
  return `https://huggingface.co/${modelId}/resolve/main/${file}`;
}

/** Ensure Model2Vec weights exist locally; download from Hugging Face Hub if needed. */
export async function ensureModel2VecWeights(
  dataDir: string,
  modelId: string = DEFAULT_MODEL_ID,
): Promise<{ modelId: string; modelDir: string }> {
  // Absolute / relative path to an already-downloaded model directory
  if (modelId.startsWith("/") || modelId.startsWith(".") || modelId.includes("\\")) {
    return { modelId, modelDir: modelId };
  }

  const modelDir = modelCacheDir(dataDir, modelId);
  await mkdir(modelDir, { recursive: true });

  for (const file of REQUIRED_FILES) {
    const dest = join(modelDir, file);
    if (await Bun.file(dest).exists()) {
      continue;
    }
    const url = hfResolveUrl(modelId, file);
    console.error(`[localdoc] downloading ${modelId}/${file} …`);
    log.info(`downloading ${modelId}/${file}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    }
    await Bun.write(dest, res);
  }

  return { modelId, modelDir };
}

export { DEFAULT_MODEL_ID };
