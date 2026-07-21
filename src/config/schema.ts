import { z } from "zod";

export const ConfigSchema = z.object({
  data_dir: z.string().default("~/.localdoc"),
  embeddings: z
    .object({
      provider: z.enum(["model2vec", "openai_compatible"]).default("model2vec"),
      model: z.string().default("minishlab/potion-base-8M"),
      openai_compatible: z
        .object({
          base_url: z.string().default("https://api.openai.com/v1"),
          api_key_env: z.string().default("OPENAI_API_KEY"),
          model: z.string().default("text-embedding-3-small"),
        })
        .optional(),
    })
    .default({
      provider: "model2vec",
      model: "minishlab/potion-base-8M",
    }),
  rerank: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(["none", "local", "cohere"]).default("none"),
      model: z.string().nullable().default(null),
      cohere: z
        .object({
          api_key_env: z.string().default("COHERE_API_KEY"),
        })
        .optional(),
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
    .object({
      /** HTTP(S) proxy URL used for both http:// and https:// requests (Bun fetch + Playwright). */
      proxy: z.string().nullable().default(null),
      headers: z.record(z.string(), z.string()).default({}),
      retries: z.number().int().nonnegative().default(3),
      /** When false, skip TLS certificate verification (self-signed / corporate MITM proxies). */
      reject_unauthorized: z.boolean().default(true),
    })
    .default({
      proxy: null,
      headers: {},
      retries: 3,
      reject_unauthorized: true,
    }),
});

export type LocaldocConfig = z.infer<typeof ConfigSchema>;
