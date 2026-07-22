import { z } from "zod";
import { migrateApiKeyFields } from "../util/api-key.ts";

function migrateRerankConfig(val: unknown): unknown {
  if (!val || typeof val !== "object" || Array.isArray(val)) return val;
  const o = migrateApiKeyFields({ ...(val as Record<string, unknown>) });

  // Promote legacy rerank.cohere.{base_url,api_key} → rerank.{base_url,api_key}
  if (o.cohere && typeof o.cohere === "object" && !Array.isArray(o.cohere)) {
    const cohere = migrateApiKeyFields({ ...(o.cohere as Record<string, unknown>) });
    if (o.base_url == null && typeof cohere.base_url === "string") {
      o.base_url = cohere.base_url;
    }
    if (o.api_key == null && typeof cohere.api_key === "string") {
      o.api_key = cohere.api_key;
    }
  }
  delete o.cohere;
  return o;
}

/** Flatten legacy embeddings.openai / openai_compatible into top-level fields. */
function migrateEmbeddingsConfig(val: unknown): unknown {
  if (!val || typeof val !== "object" || Array.isArray(val)) return val;
  const o = migrateApiKeyFields({ ...(val as Record<string, unknown>) });
  if (o.provider === "openai_compatible") o.provider = "openai";

  const nested =
    (o.openai && typeof o.openai === "object" && !Array.isArray(o.openai) && o.openai) ||
    (o.openai_compatible &&
      typeof o.openai_compatible === "object" &&
      !Array.isArray(o.openai_compatible) &&
      o.openai_compatible) ||
    null;

  if (nested) {
    const openai = migrateApiKeyFields({ ...(nested as Record<string, unknown>) });
    if (typeof openai.model === "string" && openai.model) {
      const topModel = typeof o.model === "string" ? o.model : "";
      if (!topModel || topModel === "minishlab/potion-base-8M") {
        o.model = openai.model;
      }
    }
    if (o.base_url == null && typeof openai.base_url === "string") {
      o.base_url = openai.base_url;
    }
    if (o.api_key == null && typeof openai.api_key === "string") {
      o.api_key = openai.api_key;
    }
  }
  delete o.openai;
  delete o.openai_compatible;
  return o;
}

export const ConfigSchema = z.object({
  data_dir: z.string().default("~/.localdoc"),
  embeddings: z.preprocess(
    migrateEmbeddingsConfig,
    z
      .object({
        provider: z.enum(["model2vec", "openai"]).default("model2vec"),
        /** Model id for the active provider (Model2Vec repo id or OpenAI embedding model). */
        model: z.string().default("minishlab/potion-base-8M"),
        /** Texts per embedding API / sidecar call. */
        batch_size: z.number().int().positive().default(20),
        /** Max embedding requests in flight at once (network providers). */
        max_parallel: z.number().int().positive().default(4),
        /** OpenAI-compatible API base (used when provider is openai). */
        base_url: z.string().nullable().default(null),
        /** `$ENV_NAME` or literal; optional for local openai-compatible servers. */
        api_key: z.string().nullable().default(null),
      })
      .default({
        provider: "model2vec",
        model: "minishlab/potion-base-8M",
        batch_size: 20,
        max_parallel: 4,
        base_url: null,
        api_key: null,
      }),
  ),
  rerank: z.preprocess(
    migrateRerankConfig,
    z
      .object({
        enabled: z.boolean().default(false),
        /** `openai` = llama.cpp / TEI / Jina-style POST /rerank */
        provider: z.enum(["none", "local", "cohere", "openai"]).default("none"),
        model: z.string().nullable().default(null),
        /** Shared by cohere + openai providers. */
        base_url: z.string().nullable().default(null),
        /** `$ENV_NAME` or literal; optional for local openai-compatible servers. */
        api_key: z.string().nullable().default(null),
      })
      .default({
        enabled: false,
        provider: "none",
        model: null,
        base_url: null,
        api_key: null,
      }),
  ),
  search: z
    .object({
      rrf_k: z.number().int().positive().default(60),
      fts_limit: z.number().int().positive().default(40),
      vector_limit: z.number().int().positive().default(40),
      top_k: z.number().int().positive().default(12),
      budget_tokens: z.number().int().positive().default(2400),
      /** Max chunks from the same document in the ranked list (diversity). */
      max_per_document: z.number().int().positive().default(2),
    })
    .default({
      rrf_k: 60,
      fts_limit: 40,
      vector_limit: 40,
      top_k: 12,
      budget_tokens: 2400,
      max_per_document: 2,
    }),
  chunking: z
    .object({
      chunk_size: z.number().int().positive().default(512),
      min_characters: z.number().int().positive().default(24),
      table_rows: z.number().int().positive().default(3),
      /** Characters of previous chunk prepended to the next (prose). */
      overlap: z.number().int().nonnegative().default(64),
    })
    .default({
      chunk_size: 512,
      min_characters: 24,
      table_rows: 3,
      overlap: 64,
    }),
  crawl: z
    .object({
      max_pages: z.number().int().positive().default(500),
      concurrency: z.number().int().positive().default(4),
      timeout_ms: z.number().int().positive().default(30_000),
      playwright: z.enum(["auto", "always", "never"]).default("auto"),
      respect_robots: z.boolean().default(true),
      headers: z.record(z.string(), z.string()).default({}),
    })
    .default({
      max_pages: 500,
      concurrency: 4,
      timeout_ms: 30_000,
      playwright: "auto",
      respect_robots: true,
      headers: {},
    }),
  http: z
    .preprocess(
      (val) => {
        if (!val || typeof val !== "object" || Array.isArray(val)) return val;
        const o = { ...(val as Record<string, unknown>) };
        const flatProxy = o.proxy;
        const flatTls = o.reject_unauthorized;

        if (flatProxy === null || typeof flatProxy === "string") {
          o.proxy = {
            url: flatProxy ?? null,
            ignore: [],
            reject_unauthorized: typeof flatTls === "boolean" ? flatTls : true,
          };
          delete o.reject_unauthorized;
        } else if (flatProxy && typeof flatProxy === "object" && !Array.isArray(flatProxy)) {
          const p = { ...(flatProxy as Record<string, unknown>) };
          if (p.reject_unauthorized == null && typeof flatTls === "boolean") {
            p.reject_unauthorized = flatTls;
          }
          if (p.ignore == null && typeof p.no_proxy === "string") {
            p.ignore = String(p.no_proxy)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          }
          o.proxy = p;
          delete o.reject_unauthorized;
        }
        return o;
      },
      z.object({
        proxy: z
          .object({
            url: z.string().nullable().default(null),
            ignore: z.array(z.string()).default([]),
            reject_unauthorized: z.boolean().default(true),
          })
          .default({
            url: null,
            ignore: [],
            reject_unauthorized: true,
          }),
        headers: z.record(z.string(), z.string()).default({}),
        retries: z.number().int().nonnegative().default(3),
      }),
    )
    .default({
      proxy: {
        url: null,
        ignore: [],
        reject_unauthorized: true,
      },
      headers: {},
      retries: 3,
    }),
  log: z
    .object({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
      file: z.string().nullable().default(null),
    })
    .default({
      level: "info",
      file: null,
    }),
});

export type LocaldocConfig = z.infer<typeof ConfigSchema>;
