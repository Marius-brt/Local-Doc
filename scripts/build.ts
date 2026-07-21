#!/usr/bin/env bun
/**
 * Multi-target single-file executable build via Bun.compile
 *
 * - Builds & embeds the Model2Vec Rust sidecar (default embeddings)
 * - Bundles @huggingface/transformers + platform onnxruntime natives
 * - Embeds libsql native (rewrites dynamic require)
 * - Stubs Playwright (downloaded on demand under Bun)
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BunPlugin } from "bun";

const root = join(import.meta.dir, "..");

const targets = [
  {
    target: "bun-darwin-arm64",
    outfile: "localdoc-darwin-arm64",
    libsql: "@libsql/darwin-arm64",
    onnx: {
      node: "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
      dylib: "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.24.3.dylib",
    },
  },
  {
    target: "bun-darwin-x64",
    outfile: "localdoc-darwin-x64",
    libsql: "@libsql/darwin-x64",
    onnx: {
      node: "node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/onnxruntime_binding.node",
      dylib: "node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/libonnxruntime.1.24.3.dylib",
    },
  },
  {
    target: "bun-linux-x64",
    outfile: "localdoc-linux-x64",
    libsql: "@libsql/linux-x64-gnu",
    onnx: {
      node: "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
    },
  },
  {
    target: "bun-linux-x64-musl",
    outfile: "localdoc-linux-x64-musl",
    libsql: "@libsql/linux-x64-musl",
    onnx: {
      node: "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
    },
  },
  {
    target: "bun-windows-x64",
    outfile: "localdoc-windows-x64.exe",
    libsql: "@libsql/win32-x64-msvc",
    onnx: {
      node: "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node",
    },
  },
] as const;

const stubPath = join(import.meta.dir, "stubs", "empty.ts");

const STUB_PACKAGES = [
  "playwright",
  "playwright-core",
  "chromium-bidi",
  "sharp",
  "@img/sharp-libvips-dev",
];

function stubPlugin(): BunPlugin {
  return {
    name: "localdoc-native-stubs",
    setup(build) {
      for (const pkg of STUB_PACKAGES) {
        const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({
          path: stubPath,
        }));
        build.onResolve({ filter: new RegExp(`^${escaped}/`) }, () => ({
          path: stubPath,
        }));
      }
    },
  };
}

function embedLibsqlPlugin(libsqlPkg: string): BunPlugin {
  const dynamicRequire = /require\(`@libsql\/\$\{target\}`\)/g;
  const staticRequire = `require(${JSON.stringify(libsqlPkg)})`;

  return {
    name: "localdoc-embed-libsql",
    setup(build) {
      build.onLoad({ filter: /node_modules\/libsql\/(index|promise)\.js$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        if (!dynamicRequire.test(source)) {
          return undefined;
        }
        dynamicRequire.lastIndex = 0;
        return { contents: source.replace(dynamicRequire, staticRequire), loader: "js" };
      });

      build.onResolve({ filter: /^localdoc:embed-libsql$/ }, () => ({
        path: "localdoc:embed-libsql",
        namespace: "localdoc-embed",
      }));
      build.onLoad({ filter: /.*/, namespace: "localdoc-embed" }, () => ({
        contents: `module.exports = require(${JSON.stringify(libsqlPkg)});`,
        loader: "js",
      }));
    },
  };
}

/** Rewrite onnxruntime-node dynamic binding require to LOCALDOC_ONNX_DIR when set. */
function onnxBindingPlugin(): BunPlugin {
  return {
    name: "localdoc-onnx-binding",
    setup(build) {
      build.onLoad(
        { filter: /node_modules\/onnxruntime-node\/dist\/binding\.js$/ },
        async (args) => {
          const source = await Bun.file(args.path).text();
          const rewritten = source.replace(
            /require\(`\.\.\/bin\/napi-v6\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/,
            `(() => {
            const dir = process.env.LOCALDOC_ONNX_DIR;
            if (dir) {
              const { join } = require("node:path");
              return require(join(dir, "onnxruntime_binding.node"));
            }
            return require("../bin/napi-v6/" + process.platform + "/" + process.arch + "/onnxruntime_binding.node");
          })()`,
          );
          return { contents: rewritten, loader: "js" };
        },
      );
    },
  };
}

/** Prefer LOCALDOC_CHONKIE_WASM so SFE can load WASM from a real filesystem path. */
function chonkieWasmPlugin(): BunPlugin {
  return {
    name: "localdoc-chonkie-wasm",
    setup(build) {
      build.onLoad({ filter: /node_modules\/@chonkiejs\/chunk\/index\.js$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        const needle =
          "const wasmPath = join(__dirname, 'pkg', 'chonkiejs_chunk_bg.wasm');\n            const wasmBytes = readFileSync(wasmPath);";
        if (!source.includes(needle)) {
          // Fall back to a looser replace if formatting differs
          const alt = source.replace(
            /const wasmPath = join\(__dirname, ['"]pkg['"], ['"]chonkiejs_chunk_bg\.wasm['"]\);\s*const wasmBytes = readFileSync\(wasmPath\);/,
            `const wasmPath = process.env.LOCALDOC_CHONKIE_WASM || join(__dirname, 'pkg', 'chonkiejs_chunk_bg.wasm');\n            const wasmBytes = readFileSync(wasmPath);`,
          );
          if (alt === source) {
            return undefined;
          }
          return { contents: alt, loader: "js" };
        }
        const rewritten = source.replace(
          needle,
          "const wasmPath = process.env.LOCALDOC_CHONKIE_WASM || join(__dirname, 'pkg', 'chonkiejs_chunk_bg.wasm');\n            const wasmBytes = readFileSync(wasmPath);",
        );
        return { contents: rewritten, loader: "js" };
      });
    },
  };
}

async function buildModel2VecSidecar(): Promise<string> {
  const crateDir = join(root, "native", "model2vec-cli");
  const targetDir = join(crateDir, "target");
  console.log("Building Model2Vec Rust sidecar (release)…");
  const proc = Bun.spawn(["cargo", "build", "--release"], {
    cwd: crateDir,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      // Avoid sandbox / CI redirects that place artifacts outside the repo.
      CARGO_TARGET_DIR: targetDir,
    },
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`cargo build --release failed with exit ${code}`);
  }
  const binName = process.platform === "win32" ? "localdoc-model2vec.exe" : "localdoc-model2vec";
  const bin = join(targetDir, "release", binName);
  if (!(await Bun.file(bin).exists())) {
    throw new Error(`expected sidecar at ${bin}`);
  }
  // embed-model2vec.ts imports a stable extensionless path; cargo emits *.exe on Windows.
  if (process.platform === "win32") {
    await copyFile(bin, join(targetDir, "release", "localdoc-model2vec"));
  }
  return bin;
}

async function writeEmbedOnnxGenerated(onnx: { node: string; dylib?: string }): Promise<void> {
  const nodePath = join(root, onnx.node);
  if (!(await Bun.file(nodePath).exists())) {
    throw new Error(`missing onnx native: ${onnx.node}`);
  }
  let dylibImport = "";
  let dylibField = "";
  if (onnx.dylib) {
    const dylibPath = join(root, onnx.dylib);
    if (!(await Bun.file(dylibPath).exists())) {
      throw new Error(`missing onnx dylib: ${onnx.dylib}`);
    }
    dylibImport = `import onnxDylib from ${JSON.stringify(`../../${onnx.dylib}`)} with { type: "file" };
`;
    dylibField = ", dylib: onnxDylib";
  }
  // Asset imports before local imports (Biome organizeImports).
  const contents = `/**
 * AUTO-GENERATED by scripts/build.ts — do not edit.
 */
${dylibImport}import onnxNode from ${JSON.stringify(`../../${onnx.node}`)} with { type: "file" };
import { setEmbeddedOnnxNatives } from "../embed/onnx-natives.ts";

setEmbeddedOnnxNatives({ node: onnxNode${dylibField} });
`;
  await writeFile(join(root, "src", "cli", "embed-onnx.generated.ts"), contents);
}

const outDir = join(root, "dist");
await mkdir(outDir, { recursive: true });

const entry = join(root, "src", "cli", "index.compile.ts");
const only = process.argv[2];

const host =
  process.platform === "darwin"
    ? process.arch === "arm64"
      ? "bun-darwin-arm64"
      : "bun-darwin-x64"
    : process.platform === "win32"
      ? "bun-windows-x64"
      : process.arch === "arm64"
        ? "bun-linux-arm64"
        : "bun-linux-x64";

await buildModel2VecSidecar();

for (const t of targets) {
  if (only && !t.target.includes(only) && !t.outfile.includes(only)) {
    continue;
  }

  const nativePkgPath = join(root, "node_modules", ...t.libsql.split("/"));
  const hasNative = await Bun.file(join(nativePkgPath, "package.json")).exists();
  const hasOnnx = await Bun.file(join(root, t.onnx.node)).exists();

  if ((!hasNative || !hasOnnx) && t.target !== host) {
    console.log(`Building ${t.target} → dist/${t.outfile}`);
    console.error(
      `  skipped (missing ${[!hasNative && t.libsql, !hasOnnx && "onnxruntime"].filter(Boolean).join(", ")})`,
    );
    continue;
  }
  if (!hasNative) {
    console.error(`Missing required native package ${t.libsql} for host build`);
    process.exitCode = 1;
    break;
  }
  if (!hasOnnx) {
    console.error(`Missing onnxruntime native for host build: ${t.onnx.node}`);
    process.exitCode = 1;
    break;
  }

  await writeEmbedOnnxGenerated(t.onnx);

  console.log(`Building ${t.target} → dist/${t.outfile}`);
  const result = await Bun.build({
    entrypoints: [entry],
    compile: {
      target: t.target as Bun.Build.Target,
      outfile: join(outDir, t.outfile),
    },
    minify: true,
    plugins: [stubPlugin(), embedLibsqlPlugin(t.libsql), onnxBindingPlugin(), chonkieWasmPlugin()],
    external: ["playwright", "playwright-core", "sharp"],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });
  if (!result.success) {
    if (t.target !== host) {
      console.error(`  skipped (cross-compile): ${result.logs?.[0] ?? "build failed"}`);
      continue;
    }
    console.error(result.logs);
    process.exitCode = 1;
    break;
  }
  console.log(`  ok`);
}

console.log("Done.");
console.log(
  "Standalone binary includes TUI, Model2Vec sidecar, Transformers.js + ONNX + Chonkie WASM. Playwright is stubbed.",
);
