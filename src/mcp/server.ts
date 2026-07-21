import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config/load.ts";
import { getDb } from "../db/client.ts";
import { countStats } from "../db/documents.ts";
import { getSource, listSources } from "../db/sources.ts";
import { tryCreateEmbedder } from "../embed/index.ts";
import { buildContextPack, formatPackMarkdown } from "../pack/format.ts";
import { hybridSearch, parseChunkKinds, type SearchFilters, splitList } from "../search/hybrid.ts";

export async function startMcpServer(configPath?: string): Promise<void> {
  // Connect stdio ASAP so MCP clients (OpenCode default timeout 5s) do not
  // mark the server failed while config/DB migrate is still running.
  const server = new Server(
    { name: "localdoc", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "query",
        description: "Search indexed documentation and return a compact context pack",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Max sections" },
            budget: { type: "number", description: "Token budget" },
            format: {
              type: "string",
              enum: ["markdown", "json"],
              description: "Output format",
            },
            kinds: {
              type: "array",
              items: { type: "string" },
              description:
                "Chunk kinds to include: prose, table, code (aliases: text, markdown). Optional.",
            },
            sources: {
              type: "array",
              items: { type: "string" },
              description: "Source id(s) or root URI(s) to search. Optional.",
            },
            keywords: {
              type: "array",
              items: { type: "string" },
              description: "Keywords that must appear in each returned chunk. Optional.",
            },
          },
          required: ["question"],
        },
      },
      {
        name: "list",
        description: "List indexed documentation sources",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "inspect",
        description: "Show index stats",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const { loaded, db } = await ensureDb();

    if (name === "list") {
      const sources = await listSources(db);
      return {
        content: [
          {
            type: "text",
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
    }

    if (name === "inspect") {
      const stats = await countStats(db);
      return {
        content: [
          {
            type: "text",
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
    }

    if (name === "query") {
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
          if (!src) throw new Error(`Source not found: ${ref}`);
          sourceIds.push(src.id);
        }
        filters.sourceIds = sourceIds;
      }

      const embedder = await tryCreateEmbedder(config, loaded.dataDir);
      const hits = await hybridSearch(db, question, config, embedder, filters);
      const pack = buildContextPack(question, hits, config.search.budget_tokens);
      const format = args.format === "json" ? "json" : "markdown";
      const text = format === "json" ? JSON.stringify(pack, null, 2) : formatPackMarkdown(pack);
      return { content: [{ type: "text", text }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
