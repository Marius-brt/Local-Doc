import { defineCommand } from "citty";
import { startMcpServer } from "../../mcp/server.ts";

export default defineCommand({
  meta: { name: "mcp", description: "MCP server commands" },
  subCommands: {
    serve: defineCommand({
      meta: {
        name: "serve",
        description: "Start localdoc MCP server on stdio",
      },
      args: {
        config: {
          type: "string",
          description: "Path to config.yml",
          alias: "c",
        },
      },
      async run({ args }) {
        await startMcpServer(args.config);
      },
    }),
  },
});
