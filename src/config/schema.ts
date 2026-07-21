import { z } from "zod";
import { migrateApiKeyFields } from "../util/api-key.ts";

const OpenAISchema = z.preprocess(
  (val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return migrateApiKeyFields({ ...(val as Record<string, unknown>) });
    }
    return val;
  },
  z.object({
    base_url: z.string().default("https://api.openai.com/v1"),
    /** `$ENV_NAME` reads from the environment; any other value is the literal key. */
    api_key: z.string().default("$OPENAI_API_KEY"),
    model: z.string().default("text-embedding-3-small"),
  }),
);

const CohereRerankSchema = z.preprocess(
  (val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return migrateApiKeyFields({ ...(val as Record<string, unknown>) });
    }
    return val;
  },
  z.object({
    base_url: z.string().default("https://api.cohere.com/v2"),
    /** `$ENV_NAME` reads from the environment; any other value is the literal key. */
    api_key: z.string().default("$COHERE_API_KEY"),
  }),
);

export const ConfigSchema = z.object({
  data_dir: z.string().default("~/.localdoc"),
  embeddings: z.preprocess(
    (val) => {
      if (!val || typeof val !== "object" || Array.isArray(val)) return val;
      const o = { ...(val as Record<string, unknown>) };
      if (o.provider === "openai_compatible") o.provider = "openai";
      if (o.openai == null && o.openai_compatible != null) {
        o.openai = o.openai_compatible;
      }
      delete o.openai_compatible;
      return o;
    },
    z
      .object({
        provider: z.enum(["model2vec", "openai"]).default("model2vec"),
        model: z.string().default("minishlab/potion-base-8M"),
        openai: OpenAISchema.optional(),
      })
      .default({
        provider: "model2vec",
        model: "minishlab/potion-base-8M",
      }),
  ),
  rerank: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(["none", "local", "cohere"]).default("none"),
      model: z.string().nullable().default(null),
      cohere: CohereRerankSchema.optional(),
    })
    .default({
      enabled: false,
      provider: "none",
      model: null,
    }),
  search: z
    .object({
      rrf_k: z.number().int().positive().default(60),
      fts_limit: z.number().int().positive().default(40),
      vector_limit: z.number().int().positive().default(40),
      top_k: z.number().int().positive().default(12),
      budget_tokens: z.number().int().positive().default(2400),
    })
    .default({
      rrf_k: 60,
      fts_limit: 40,
      vector_limit: 40,
      top_k: 12,
      budget_tokens: 2400,
    }),
  chunking: z
    .object({
      chunk_size: z.number().int().positive().default(512),
      min_characters: z.number().int().positive().default(24),
      table_rows: z.number().int().positive().default(3),
    })
    .default({
      chunk_size: 512,
      min_characters: 24,
      table_rows: 3,
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
          // Accept legacy `url` alias from `proxy: "http://..."` already handled;
          // also map `no_proxy` → ignore if present
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
            /** HTTP(S)/SOCKS proxy URL for both http:// and https:// targets. */
            url: z.string().nullable().default(null),
            /** Hosts that bypass the proxy (exact, `.domain`, or `*.domain`). */
            ignore: z.array(z.string()).default([]),
            /** When false, skip TLS certificate verification (insecure). */
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
});

export type LocaldocConfig = z.infer<typeof ConfigSchema>;
