import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config/load.ts";
import { getDb } from "../db/client.ts";
import { countStats } from "../db/documents.ts";
import { getSource, listSources } from "../db/sources.ts";
import { tryCreateEmbedder } from "../embed/index.ts";
import { buildContextPack, formatPackMarkdown } from "../pack/format.ts";
import { hybridSearch, parseChunkKinds, type SearchFilters, splitList } from "../search/hybrid.ts";
import { VERSION } from "../version.ts";

function toolError(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

export async function startMcpServer(configPath?: string): Promise<void> {
  // Connect stdio ASAP so MCP clients (OpenCode default timeout 5s) do not
  // mark the server failed while config/DB migrate is still running.
  const server = new McpServer({ name: "localdoc", version: VERSION });

  type Loaded = Awaited<ReturnType<typeof loadConfig>>;
  type Db = Awaited<ReturnType<typeof getDb>>;
  let loadedPromise: Promise<Loaded> | null = null;
  let dbPromise: Promise<Db> | null = null;

  const ensureLoaded = () => {
    loadedPromise ??= loadConfig(configPath);
    return loadedPromise;
  };
  const ensureDb = async () => {
    const loaded = await ensureLoaded();
    dbPromise ??= getDb(loaded.dataDir);
    return { loaded, db: await dbPromise };
  };

  server.registerTool(
    "query",
    {
      description: "Search indexed documentation and return a compact context pack",
      inputSchema: {
        question: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max sections"),
        budget: z.number().optional().describe("Token budget"),
        format: z.enum(["markdown", "json"]).optional().describe("Output format"),
        kinds: z
          .array(z.string())
          .optional()
          .describe(
            "Chunk kinds to include: prose, table, code (aliases: text, markdown). Optional.",
          ),
        sources: z
          .array(z.string())
          .optional()
          .describe("Source id(s) or root URI(s) to search. Optional."),
        keywords: z
          .array(z.string())
          .optional()
          .describe("Keywords that must appear in each returned chunk. Optional."),
      },
    },
    async (args) => {
      try {
        const { loaded, db } = await ensureDb();
        const question = String(args.question ?? "");
        const config = { ...loaded.config };
        if (typeof args.limit === "number") {
          config.search = { ...config.search, top_k: args.limit };
        }
        if (typeof args.budget === "number") {
          config.search = { ...config.search, budget_tokens: args.budget };
        }

        const kindValues = Array.isArray(args.kinds)
          ? args.kinds.map(String)
          : typeof args.kinds === "string"
            ? splitList(args.kinds)
            : [];
        const sourceRefs = Array.isArray(args.sources)
          ? args.sources.map(String)
          : typeof args.sources === "string"
            ? splitList(args.sources)
            : [];
        const keywords = Array.isArray(args.keywords)
          ? args.keywords.map(String).filter(Boolean)
          : typeof args.keywords === "string"
            ? splitList(args.keywords)
            : [];

        const filters: SearchFilters = {};
        const kinds = parseChunkKinds(kindValues);
        if (kinds.length) filters.kinds = kinds;
        if (keywords.length) filters.keywords = keywords;
        if (sourceRefs.length) {
          const sourceIds: string[] = [];
          for (const ref of sourceRefs) {
            const src = await getSource(db, ref);
            if (!src) return toolError(`Source not found: ${ref}`);
            sourceIds.push(src.id);
          }
          filters.sourceIds = sourceIds;
        }

        const embedder = await tryCreateEmbedder(config, loaded.dataDir);
        const hits = await hybridSearch(db, question, config, embedder, filters);
        const pack = buildContextPack(question, hits, config.search.budget_tokens);
        const format = args.format === "json" ? "json" : "markdown";
        const text = format === "json" ? JSON.stringify(pack, null, 2) : formatPackMarkdown(pack);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "list",
    {
      description: "List indexed documentation sources",
      inputSchema: {},
    },
    async () => {
      try {
        const { db } = await ensureDb();
        const sources = await listSources(db);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                sources.map((s) => ({
                  id: s.id,
                  kind: s.kind,
                  root_uri: s.root_uri,
                  status: s.status,
                  strategy: s.strategy,
                })),
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "inspect",
    {
      description: "Show index stats",
      inputSchema: {},
    },
    async () => {
      try {
        const { loaded, db } = await ensureDb();
        const stats = await countStats(db);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  dataDir: loaded.dataDir,
                  db: join(loaded.dataDir, "index.db"),
                  ...stats,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
