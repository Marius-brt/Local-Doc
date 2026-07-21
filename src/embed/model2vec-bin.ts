import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

const BIN_NAME = process.platform === "win32" ? "localdoc-model2vec.exe" : "localdoc-model2vec";

/** Set by compile entry when the Rust sidecar is embedded in the SFE. */
let embeddedBinaryPath: string | null = null;

export function setEmbeddedModel2VecPath(path: string): void {
  embeddedBinaryPath = path;
}

async function materialize(src: string, dest: string): Promise<void> {
  // $bunfs paths often fail with fs.copyFile — read via Bun.file instead.
  const bytes = await Bun.file(src).arrayBuffer();
  await Bun.write(dest, bytes);
  if (process.platform !== "win32") {
    await chmod(dest, 0o755);
  }
}

export async function ensureModel2VecBinary(dataDir: string): Promise<string> {
  const destDir = join(dataDir, "bin");
  const dest = join(destDir, BIN_NAME);
  await mkdir(destDir, { recursive: true });

  const candidates: string[] = [];
  if (embeddedBinaryPath) {
    candidates.push(embeddedBinaryPath);
  }
  candidates.push(
    join(import.meta.dir, "..", "..", "native", "model2vec-cli", "target", "release", BIN_NAME),
    join(import.meta.dir, "..", "..", "native", "model2vec-cli", "target", "debug", BIN_NAME),
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
    return dest;
  }

  const which = Bun.which("localdoc-model2vec");
  if (which) {
    return which;
  }

  throw new Error(
    "localdoc-model2vec binary not found. Run `bun run build` or `cargo build --release` in native/model2vec-cli.",
  );
}
