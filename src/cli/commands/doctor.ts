import { access } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { defineCommand } from "citty";
import { getDb } from "../../db/client.ts";
import { countStats } from "../../db/documents.ts";
import { createCtx } from "../context.ts";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export default defineCommand({
  meta: { name: "doctor", description: "Check config, index health, and tooling" },
  args: {
    config: { type: "string", description: "Path to config.yml", alias: "c" },
  },
  async run({ args }) {
    const ctx = await createCtx(args.config);
    const { loaded } = ctx;
    console.log(chalk.bold("localdoc doctor"));
    console.log(`Config: ${loaded.configPath}${loaded.created ? " (created)" : ""}`);
    console.log(`Data dir: ${loaded.dataDir}`);

    const db = await getDb(loaded.dataDir);
    const stats = await countStats(db);
    console.log(
      `Index: ${stats.sources} sources, ${stats.documents} documents, ${stats.chunks} chunks, ${stats.embeddings} embeddings`,
    );

    const checks: Array<[string, boolean, string]> = [
      ["config writable", true, loaded.configPath],
      ["models dir", await exists(join(loaded.dataDir, "models")), join(loaded.dataDir, "models")],
      [
        "extracted dir",
        await exists(join(loaded.dataDir, "extracted")),
        join(loaded.dataDir, "extracted"),
      ],
      [
        "last ingest report",
        await exists(join(loaded.dataDir, "last-ingest-report.json")),
        join(loaded.dataDir, "last-ingest-report.json"),
      ],
    ];

    for (const [name, ok, detail] of checks) {
      console.log(
        `${ok ? chalk.green("ok") : chalk.yellow("—")}  ${name}${detail ? ` (${detail})` : ""}`,
      );
    }

    console.log(`Embeddings provider: ${loaded.config.embeddings.provider}`);
    console.log(
      `Rerank: ${loaded.config.rerank.enabled ? loaded.config.rerank.provider : "disabled"}`,
    );
    console.log(`Playwright mode: ${loaded.config.crawl.playwright}`);
    console.log(chalk.green("Doctor complete."));
  },
});
