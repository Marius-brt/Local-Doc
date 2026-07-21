import type { Client } from "@libsql/client";
import chalk from "chalk";
import { defineCommand } from "citty";
import { getDb } from "../../db/client.ts";
import { getSource } from "../../db/sources.ts";
import { tryCreateEmbedder } from "../../embed/index.ts";
import { buildContextPack, formatPackMarkdown } from "../../pack/format.ts";
import {
  hybridSearch,
  parseChunkKinds,
  type SearchFilters,
  splitList,
} from "../../search/hybrid.ts";
import { flushLog, formatError, log } from "../../util/log.ts";
import { createCtx } from "../context.ts";

async function resolveSourceIds(db: Client, refs: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const ref of refs) {
    const src = await getSource(db, ref);
    if (!src) {
      throw new Error(`Source not found: ${ref}`);
    }
    ids.push(src.id);
  }
  return ids;
}

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
    kind: {
      type: "string",
      description:
        "Chunk kinds to include: prose,table,code (comma-separated; aliases: text,markdown)",
    },
    source: {
      type: "string",
      description: "Limit to source id(s) or root URI(s), comma-separated",
    },
    keyword: {
      type: "string",
      description: "Require these keywords in each chunk (comma-separated)",
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

    try {
      const kinds = parseChunkKinds(splitList(args.kind));
      const sourceRefs = splitList(args.source);
      const keywords = splitList(args.keyword);
      const filters: SearchFilters = {};
      if (kinds.length) filters.kinds = kinds;
      if (keywords.length) filters.keywords = keywords;
      if (sourceRefs.length) filters.sourceIds = await resolveSourceIds(db, sourceRefs);

      const embedder = await tryCreateEmbedder(config, ctx.loaded.dataDir);
      const hits = await hybridSearch(db, String(args.question), config, embedder, filters);
      const pack = buildContextPack(String(args.question), hits, config.search.budget_tokens);

      if (args.format === "json") {
        console.log(JSON.stringify(pack, null, 2));
      } else {
        console.log(formatPackMarkdown(pack));
      }
    } catch (err) {
      log.error(`query failed: ${formatError(err)}`);
      await flushLog();
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  },
});
