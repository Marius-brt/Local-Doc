import type { Client } from "@libsql/client";
import type { LocaldocConfig } from "../config/schema.ts";
import { nowIso } from "../db/client.ts";
import { insertEmbedding } from "../db/documents.ts";
import { getVectorDims, rebuildVectorTable } from "../db/vector-index.ts";
import { tryCreateEmbedder } from "../embed/index.ts";

export interface ReembedProgress {
  phase: string;
  current?: number;
  total?: number;
  message?: string;
}

export interface ReembedOptions {
  signal?: AbortSignal;
  onProgress?: (p: ReembedProgress) => void;
  /** Texts per embed() call. */
  batchSize?: number;
  sourceId?: string;
}

export interface ReembedReport {
  chunksTotal: number;
  chunksEmbedded: number;
  modelId: string;
  dims: number;
  previousDims: number | null;
  startedAt: string;
  finishedAt: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Cancelled");
    err.name = "AbortError";
    throw err;
  }
}

/** Let the TUI process keyboard / mouse (Escape, Cancel) between heavy work. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Recompute embeddings for existing chunks — no crawl / re-fetch. */
export async function reembedChunks(
  db: Client,
  config: LocaldocConfig,
  dataDir: string,
  options: ReembedOptions = {},
): Promise<ReembedReport> {
  const startedAt = nowIso();
  const progress = options.onProgress ?? (() => {});
  const batchSize = Math.max(1, options.batchSize ?? config.embeddings.batch_size ?? 20);

  progress({ phase: "embedder", message: "Loading embedding model…" });
  await yieldToUi();
  const embedder = await tryCreateEmbedder(config, dataDir);
  if (!embedder) {
    throw new Error("No embedder available — check embeddings config");
  }

  throwIfAborted(options.signal);
  await yieldToUi();

  const res = options.sourceId
    ? await db.execute({
        sql: "SELECT id, text FROM chunks WHERE source_id = ? ORDER BY rowid",
        args: [options.sourceId],
      })
    : await db.execute("SELECT id, text FROM chunks ORDER BY rowid");

  const chunks = res.rows.map((r) => ({
    id: String(r.id),
    text: String(r.text ?? ""),
  }));

  if (chunks.length === 0) {
    return {
      chunksTotal: 0,
      chunksEmbedded: 0,
      modelId: embedder.modelId,
      dims: embedder.dims,
      previousDims: await getVectorDims(db),
      startedAt,
      finishedAt: nowIso(),
    };
  }

  // Probe the live model so we know the new dimensionality before touching the index.
  progress({ phase: "probe", message: "Probing embedding dimensions…" });
  await yieldToUi();
  throwIfAborted(options.signal);
  const probeText = chunks.find((c) => c.text.trim())?.text || "dimension probe";
  const [probeVec] = await embedder.embed([probeText.slice(0, 2000)], options.signal);
  const dims = probeVec?.length ?? 0;
  if (dims <= 0) {
    throw new Error("Embedder returned an empty vector — cannot rebuild vector index");
  }

  const previousDims = await getVectorDims(db);
  throwIfAborted(options.signal);
  await yieldToUi();

  // libSQL stores dims in the column type + vector index — rebuild before inserts.
  progress({
    phase: "index",
    total: chunks.length,
    message:
      previousDims != null && previousDims !== dims
        ? `Rebuilding vector index ${previousDims}-d → ${dims}-d`
        : `Preparing vector index (${dims}-d)`,
  });
  await yieldToUi();

  if (options.sourceId && previousDims != null && previousDims === dims) {
    // Same dimensionality: only replace this source's vectors.
    await db.execute({
      sql: "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id = ?)",
      args: [options.sourceId],
    });
  } else {
    // Full wipe + schema/index rebuild (required when dims change; safest for full re-embed).
    await rebuildVectorTable(db, dims, { preserveMatchingRows: false });
  }

  let embedded = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    throwIfAborted(options.signal);
    await yieldToUi();

    const batch = chunks.slice(i, i + batchSize);
    progress({
      phase: "embed",
      current: Math.min(i + batch.length, chunks.length),
      total: chunks.length,
      message: `${embedder.modelId} · ${dims}-d`,
    });

    const vectors = await embedder.embed(
      batch.map((c) => c.text),
      options.signal,
    );
    throwIfAborted(options.signal);

    for (let j = 0; j < batch.length; j++) {
      throwIfAborted(options.signal);
      const vec = vectors[j];
      if (!vec) continue;
      if (vec.length !== dims) {
        throw new Error(
          `Embedding dim mismatch: expected ${dims}, got ${vec.length} for chunk ${batch[j]!.id}`,
        );
      }
      await insertEmbedding(db, batch[j]!.id, embedder.modelId, vec);
      embedded++;
      // Periodic yield during large write bursts
      if (j > 0 && j % 5 === 0) {
        await yieldToUi();
        throwIfAborted(options.signal);
      }
    }
  }

  progress({
    phase: "done",
    current: embedded,
    total: chunks.length,
    message: `${embedder.modelId} · ${dims}-d index ready`,
  });

  return {
    chunksTotal: chunks.length,
    chunksEmbedded: embedded,
    modelId: embedder.modelId,
    dims,
    previousDims,
    startedAt,
    finishedAt: nowIso(),
  };
}
