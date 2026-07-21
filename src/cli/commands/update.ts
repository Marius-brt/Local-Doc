import chalk from "chalk";
import { defineCommand } from "citty";
import { getDb } from "../../db/client.ts";
import { getSource, listSources } from "../../db/sources.ts";
import { ingestTarget } from "../../sources/ingest.ts";
import { createCtx } from "../context.ts";

export default defineCommand({
  meta: {
    name: "update",
    description: "Re-fetch and re-index all sources, or one specific source",
  },
  args: {
    source: {
      type: "positional",
      description: "Source id or root URI (optional)",
      required: false,
    },
    config: { type: "string", description: "Path to config.yml", alias: "c" },
  },
  async run({ args }) {
    const ctx = await createCtx(args.config);
    const db = await getDb(ctx.loaded.dataDir);

    let targets: string[] = [];
    if (args.source) {
      const src = await getSource(db, String(args.source));
      if (!src) {
        console.error(chalk.red(`Source not found: ${args.source}`));
        process.exitCode = 1;
        return;
      }
      targets = [src.root_uri];
    } else {
      const sources = await listSources(db);
      targets = sources.map((s) => s.root_uri);
    }

    if (targets.length === 0) {
      console.log("No sources to update.");
      return;
    }

    for (const target of targets) {
      console.log(chalk.bold(`Updating ${target}…`));
      const report = await ingestTarget(db, ctx.loaded.config, ctx.loaded.dataDir, target, {
        recreate: false,
      });
      console.log(
        `  ${report.pagesOk} ok, ${report.pagesSkipped} skipped, ${report.pagesFailed} failed`,
      );
    }
  },
});
