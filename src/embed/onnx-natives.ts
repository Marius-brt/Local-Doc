import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

type OnnxNativeFiles = {
  node: string;
  dylib?: string;
};

/** Filled by compile entry when ONNX natives are embedded. */
let embeddedOnnx: OnnxNativeFiles | null = null;

export function setEmbeddedOnnxNatives(files: OnnxNativeFiles): void {
  embeddedOnnx = files;
}

async function materialize(src: string, dest: string): Promise<void> {
  const bytes = await Bun.file(src).arrayBuffer();
  await Bun.write(dest, bytes);
}

/**
 * Extract ONNX Runtime natives next to each other under dataDir so
 * `@rpath/libonnxruntime*.dylib` resolves when loading the `.node` binding.
 */
export async function ensureOnnxNatives(dataDir: string): Promise<string | null> {
  if (!embeddedOnnx?.node) {
    return null;
  }
  const destDir = join(dataDir, "native", "onnxruntime");
  await mkdir(destDir, { recursive: true });

  const nodeName = "onnxruntime_binding.node";
  const nodeDest = join(destDir, nodeName);
  if (
    !(await Bun.file(nodeDest).exists()) ||
    (await Bun.file(embeddedOnnx.node).size) !== (await Bun.file(nodeDest).size)
  ) {
    await materialize(embeddedOnnx.node, nodeDest);
  }

  if (embeddedOnnx.dylib) {
    const base = embeddedOnnx.dylib.split(/[/\\]/).pop() ?? "libonnxruntime.dylib";
    const dylibDest = join(destDir, base);
    if (
      !(await Bun.file(dylibDest).exists()) ||
      (await Bun.file(embeddedOnnx.dylib).size) !== (await Bun.file(dylibDest).size)
    ) {
      await materialize(embeddedOnnx.dylib, dylibDest);
    }
  }

  if (process.platform !== "win32") {
    await chmod(nodeDest, 0o755);
  }

  process.env.LOCALDOC_ONNX_DIR = destDir;
  return destDir;
}
