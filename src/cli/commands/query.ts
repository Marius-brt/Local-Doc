import { defineCommand } from "citty";
import { getDb } from "../../db/client.ts";
import { tryCreateEmbedder } from "../../embed/index.ts";
import { buildContextPack, formatPackMarkdown } from "../../pack/format.ts";
import { hybridSearch } from "../../search/hybrid.ts";
import { createCtx } from "../context.ts";

export default defineCommand({
  meta: {
    name: "query",
    description: "Search indexed docs and print a compact context pack",
  },
  args: {
    question: {
      type: "positional",
      description: "Search query",
      required: true,
    },
    config: { type: "string", description: "Path to config.yml", alias: "c" },
    limit: { type: "string", description: "Max sections to return" },
    budget: { type: "string", description: "Max output tokens" },
    format: {
      type: "string",
      description: "Output format: markdown|json",
      default: "markdown",
    },
  },
  async run({ args }) {
    const ctx = await createCtx(args.config);
    const db = await getDb(ctx.loaded.dataDir);
    const config = { ...ctx.loaded.config };
    if (args.limit) config.search = { ...config.search, top_k: Number(args.limit) };
    if (args.budget) {
      config.search = {
        ...config.search,
        budget_tokens: Number(args.budget),
      };
    }

    const embedder = await tryCreateEmbedder(config, ctx.loaded.dataDir);
    const hits = await hybridSearch(db, String(args.question), config, embedder);
    const pack = buildContextPack(String(args.question), hits, config.search.budget_tokens);

    if (args.format === "json") {
      console.log(JSON.stringify(pack, null, 2));
    } else {
      console.log(formatPackMarkdown(pack));
    }
  },
});
