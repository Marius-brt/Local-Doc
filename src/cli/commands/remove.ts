import chalk from "chalk";
import { defineCommand } from "citty";
import { getDb } from "../../db/client.ts";
import { listSources, removeAllSources, removeSource } from "../../db/sources.ts";
import { createCtx } from "../context.ts";

export default defineCommand({
  meta: { name: "remove", description: "Remove a source or clear the entire index" },
  args: {
    source: {
      type: "positional",
      description: "Source id or root URI",
      required: false,
    },
    all: { type: "boolean", description: "Remove all sources", default: false },
    config: { type: "string", description: "Path to config.yml", alias: "c" },
  },
  async run({ args }) {
    const ctx = await createCtx(args.config);
    const db = await getDb(ctx.loaded.dataDir);

    if (args.all) {
      const n = await removeAllSources(db);
      console.log(chalk.green(`Removed ${n} sources.`));
      return;
    }
    if (!args.source) {
      console.error("Provide a source id/URI or --all");
      process.exitCode = 1;
      return;
    }
    const ok = await removeSource(db, String(args.source));
    if (!ok) {
      console.error(chalk.red(`Source not found: ${args.source}`));
      const sources = await listSources(db);
      if (sources.length) {
        console.log("Available:");
        for (const s of sources) console.log(`  ${s.id}  ${s.root_uri}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`Removed ${args.source}`));
  },
});
