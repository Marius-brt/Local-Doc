import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Set by compile entry when Chonkie WASM is embedded in the SFE. */
let embeddedWasmPath: string | null = null;

export function setEmbeddedChonkieWasmPath(path: string): void {
  embeddedWasmPath = path;
}

async function materialize(src: string, dest: string): Promise<void> {
  const bytes = await Bun.file(src).arrayBuffer();
  await Bun.write(dest, bytes);
}

/**
 * Ensure Chonkie's WASM is on a real filesystem path (Bun SFE $bunfs + readFileSync
 * fails otherwise). Sets LOCALDOC_CHONKIE_WASM for the patched loader.
 */
export async function ensureChonkieWasm(dataDir: string): Promise<string> {
  const destDir = join(dataDir, "native", "chonkie");
  const dest = join(destDir, "chonkiejs_chunk_bg.wasm");
  await mkdir(destDir, { recursive: true });

  const candidates: string[] = [];
  if (embeddedWasmPath) {
    candidates.push(embeddedWasmPath);
  }
  candidates.push(
    join(
      import.meta.dir,
      "..",
      "..",
      "node_modules",
      "@chonkiejs",
      "chunk",
      "pkg",
      "chonkiejs_chunk_bg.wasm",
    ),
  );

  for (const cand of candidates) {
    if (!(await Bun.file(cand).exists())) {
      continue;
    }
    const needsCopy =
      !(await Bun.file(dest).exists()) ||
      (await Bun.file(cand).size) !== (await Bun.file(dest).size);
    if (needsCopy) {
      await materialize(cand, dest);
    }
    process.env.LOCALDOC_CHONKIE_WASM = dest;
    return dest;
  }

  throw new Error(
    "Chonkie WASM not found. Reinstall @chonkiejs/chunk or rebuild the standalone binary.",
  );
}
