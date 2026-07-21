import chalk from "chalk";
import { defineCommand } from "citty";
import { getDb } from "../../db/client.ts";
import { listSources } from "../../db/sources.ts";
import { formatUriForDisplay } from "../../util/file-uri.ts";
import { createCtx } from "../context.ts";

export default defineCommand({
  meta: { name: "list", description: "Show indexed documentation sources" },
  args: {
    all: {
      type: "boolean",
      description: "Show every stored document",
      default: false,
    },
    config: { type: "string", description: "Path to config.yml", alias: "c" },
  },
  async run({ args }) {
    const ctx = await createCtx(args.config);
    const db = await getDb(ctx.loaded.dataDir);
    const sources = await listSources(db);

    if (sources.length === 0) {
      console.log("No sources indexed. Use `localdoc add <url|folder|github>`.");
      return;
    }

    console.log(chalk.bold(`Sources (${sources.length})`));
    for (const s of sources) {
      console.log(
        `${chalk.cyan(s.id)}  ${s.kind.padEnd(7)}  ${s.status.padEnd(10)}  ${formatUriForDisplay(s.root_uri)}` +
          (s.strategy ? chalk.dim(`  [${s.strategy}]`) : ""),
      );
    }

    if (args.all) {
      const docs = await db.execute(`
        SELECT d.uri, d.title, d.status, s.root_uri
        FROM documents d
        JOIN sources s ON s.id = d.source_id
        ORDER BY s.root_uri, d.uri
      `);
      console.log("");
      console.log(chalk.bold(`Documents (${docs.rows.length})`));
      for (const row of docs.rows) {
        const uri = formatUriForDisplay(String(row.uri));
        console.log(`  ${row.status}  ${uri}${row.title ? chalk.dim(`  (${row.title})`) : ""}`);
      }
    }
  },
});
