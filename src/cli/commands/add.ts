import chalk from "chalk";
import { defineCommand } from "citty";
import type { DiscoveryStrategy } from "../../crawl/discover.ts";
import { getDb } from "../../db/client.ts";
import { ingestTarget } from "../../sources/ingest.ts";
import { createCtx } from "../context.ts";

export default defineCommand({
  meta: {
    name: "add",
    description: "Fetch and index docs from a URL, GitHub repo, or folder",
  },
  args: {
    target: { type: "positional", description: "URL, github repo, or folder path", required: true },
    config: { type: "string", description: "Path to config.yml", alias: "c" },
    strategy: {
      type: "string",
      description: "Force discovery strategy (llms-full.txt|llms.txt|sitemap.xml|nav-crawl)",
    },
    recreate: {
      type: "boolean",
      description: "Rebuild index for this source",
      default: false,
    },
  },
  async run({ args }) {
    const ctx = await createCtx(args.config);
    const db = await getDb(ctx.loaded.dataDir);
    console.log(chalk.bold(`Adding ${args.target}…`));

    const report = await ingestTarget(
      db,
      ctx.loaded.config,
      ctx.loaded.dataDir,
      String(args.target),
      {
        recreate: Boolean(args.recreate),
        strategy: args.strategy as DiscoveryStrategy | undefined,
        onProgress: (p) => {
          if (p.current && p.total) {
            process.stdout.write(
              `\r[${p.phase}] ${p.current}/${p.total} ${p.message ?? ""}`.slice(0, 100),
            );
          } else if (p.message) {
            console.log(`[${p.phase}] ${p.message}`);
          }
        },
      },
    );
    process.stdout.write("\n");
    console.log(
      chalk.green(
        `Done: ${report.pagesOk} ok, ${report.pagesSkipped} skipped, ${report.pagesFailed} failed` +
          (report.strategy ? ` (strategy: ${report.strategy})` : ""),
      ),
    );
    if (report.errors.length > 0) {
      console.log(chalk.yellow(`First errors:`));
      for (const e of report.errors.slice(0, 5)) {
        console.log(`  - ${e.uri}: ${e.error}`);
      }
    }
    console.log(`Source id: ${report.sourceId}`);
  },
});
