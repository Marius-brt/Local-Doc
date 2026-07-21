import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../util/log.ts";

const DEFAULT_MODEL_ID = "minishlab/potion-base-8M";

const REQUIRED_FILES = ["config.json", "tokenizer.json", "model.safetensors"] as const;

const HF_HOSTS = new Set(["huggingface.co", "hf.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co"]);

function modelCacheDir(dataDir: string, modelId: string): string {
  const safe = modelId.replace(/[^\w.-]+/g, "__");
  return join(dataDir, "models", "model2vec", safe);
}

function hfResolveUrl(modelId: string, file: string): string {
  // Reject path traversal / absolute URLs smuggled into model id.
  if (
    !modelId ||
    modelId.includes("..") ||
    modelId.includes("://") ||
    modelId.startsWith("/") ||
    modelId.includes("\\")
  ) {
    throw new Error(`Invalid Hugging Face model id: ${modelId}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(modelId)) {
    throw new Error(`Invalid Hugging Face model id (expected org/name): ${modelId}`);
  }
  return `https://huggingface.co/${modelId}/resolve/main/${file}`;
}

function assertAllowedDownloadUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS model download: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    HF_HOSTS.has(host) ||
    host.endsWith(".huggingface.co") ||
    host.endsWith(".hf.co");
  if (!allowed) {
    throw new Error(`Refusing model download from unexpected host: ${host}`);
  }
}

/** Download a single file, following redirects only within Hugging Face hosts. */
async function downloadHfFile(url: string, dest: string): Promise<void> {
  const maxRedirects = 8;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertAllowedDownloadUrl(current);
    const res = await fetch(current, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`Redirect without Location from ${current}`);
      }
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    }
    assertAllowedDownloadUrl(res.url || current);
    await Bun.write(dest, res);
    return;
  }
  throw new Error(`Too many redirects downloading ${url}`);
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
  await mkdir(modelDir, { recursive: true, mode: 0o700 });

  for (const file of REQUIRED_FILES) {
    const dest = join(modelDir, file);
    if (await Bun.file(dest).exists()) {
      continue;
    }
    const url = hfResolveUrl(modelId, file);
    console.error(`[localdoc] downloading ${modelId}/${file} …`);
    log.info(`downloading ${modelId}/${file}`);
    await downloadHfFile(url, dest);
  }

  return { modelId, modelDir };
}

export { DEFAULT_MODEL_ID };
