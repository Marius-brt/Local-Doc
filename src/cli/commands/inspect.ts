import { join } from "node:path";
import chalk from "chalk";
import { defineCommand } from "citty";
import { getDb } from "../../db/client.ts";
import { countStats } from "../../db/documents.ts";
import { listSources } from "../../db/sources.ts";
import { formatUriForDisplay } from "../../util/file-uri.ts";
import { getLogPath } from "../../util/log.ts";
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
    const logPath = getLogPath();

    console.log(chalk.bold("localdoc inspect"));
    console.log(`Data dir: ${ctx.loaded.dataDir}`);
    console.log(`DB: ${join(ctx.loaded.dataDir, "index.db")}`);
    console.log(
      `Counts: sources=${stats.sources} documents=${stats.documents} chunks=${stats.chunks} embeddings=${stats.embeddings}`,
    );
    console.log(`Extracted: ${join(ctx.loaded.dataDir, "extracted")}`);
    console.log(`Models: ${join(ctx.loaded.dataDir, "models")}`);
    if (logPath) console.log(`Log: ${logPath}`);

    if (sources.length) {
      console.log("");
      console.log(chalk.bold("Sources"));
      for (const s of sources) {
        console.log(`  ${s.id}  ${s.kind}  ${s.status}  ${formatUriForDisplay(s.root_uri)}`);
      }
    }
  },
});
