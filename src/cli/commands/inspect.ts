import { readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { defineCommand } from "citty";
import { getDb } from "../../db/client.ts";
import { countStats } from "../../db/documents.ts";
import { listSources } from "../../db/sources.ts";
import { formatUriForDisplay } from "../../util/file-uri.ts";
import { createCtx } from "../context.ts";

export default defineCommand({
  meta: { name: "inspect", description: "Show index stats and extract locations" },
  args: {
    config: { type: "string", description: "Path to config.yml", alias: "c" },
  },
  async run({ args }) {
    const ctx = await createCtx(args.config);
    const db = await getDb(ctx.loaded.dataDir);
    const stats = await countStats(db);
    const sources = await listSources(db);

    console.log(chalk.bold("localdoc inspect"));
    console.log(`Data dir: ${ctx.loaded.dataDir}`);
    console.log(`DB: ${join(ctx.loaded.dataDir, "index.db")}`);
    console.log(
      `Counts: sources=${stats.sources} documents=${stats.documents} chunks=${stats.chunks} embeddings=${stats.embeddings}`,
    );
    console.log(`Extracted: ${join(ctx.loaded.dataDir, "extracted")}`);
    console.log(`Models: ${join(ctx.loaded.dataDir, "models")}`);

    if (sources.length) {
      console.log("");
      console.log(chalk.bold("Sources"));
      for (const s of sources) {
        console.log(`  ${s.id}  ${s.kind}  ${s.status}  ${formatUriForDisplay(s.root_uri)}`);
      }
    }

    const reportPath = join(ctx.loaded.dataDir, "last-ingest-report.json");
    try {
      const raw = await readFile(reportPath, "utf8");
      const report = JSON.parse(raw) as {
        pagesOk: number;
        pagesFailed: number;
        pagesSkipped: number;
        strategy?: string;
        rootUri: string;
      };
      console.log("");
      console.log(chalk.bold("Last ingest"));
      console.log(
        `  ${report.rootUri}  ok=${report.pagesOk} skipped=${report.pagesSkipped} failed=${report.pagesFailed}` +
          (report.strategy ? ` strategy=${report.strategy}` : ""),
      );
    } catch {
      // none
    }
  },
});
