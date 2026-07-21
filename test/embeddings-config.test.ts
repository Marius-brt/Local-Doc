import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.ts";

describe("embeddings config", () => {
  test("accepts flat base_url and api_key", () => {
    const cfg = ConfigSchema.parse({
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        base_url: "http://127.0.0.1:1234",
        api_key: "empty",
      },
    });
    expect(cfg.embeddings.base_url).toBe("http://127.0.0.1:1234");
    expect(cfg.embeddings.api_key).toBe("empty");
    expect(cfg.embeddings).not.toHaveProperty("openai");
  });

  test("migrates legacy embeddings.openai nest", () => {
    const cfg = ConfigSchema.parse({
      embeddings: {
        provider: "openai",
        model: "minishlab/potion-base-8M",
        openai: {
          model: "text-embedding-nomic-embed-text-v1.5",
          base_url: "http://127.0.0.1:1234",
          api_key: "emptyy",
        },
      },
    });
    expect(cfg.embeddings.model).toBe("text-embedding-nomic-embed-text-v1.5");
    expect(cfg.embeddings.base_url).toBe("http://127.0.0.1:1234");
    expect(cfg.embeddings.api_key).toBe("emptyy");
    expect(cfg.embeddings).not.toHaveProperty("openai");
  });
});
