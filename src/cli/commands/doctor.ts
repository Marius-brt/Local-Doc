import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { defineCommand } from "citty";
import { parse as parseYaml } from "yaml";
import { ConfigSchema } from "../../config/schema.ts";
import { getDb } from "../../db/client.ts";
import { countStats } from "../../db/documents.ts";
import { getLogPath, log } from "../../util/log.ts";
import { createCtx } from "../context.ts";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function validateConfigFile(configPath: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const text = await readFile(configPath, "utf8");
    const raw = parseYaml(text) ?? {};
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, detail: issues };
    }
    return { ok: true, detail: configPath };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
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
    const logPath = getLogPath();
    log.info(`doctor start config=${loaded.configPath}`);

    console.log(chalk.bold("localdoc doctor"));
    console.log(`Config: ${loaded.configPath}${loaded.created ? " (created)" : ""}`);
    console.log(`Data dir: ${loaded.dataDir}`);
    if (logPath) console.log(`Log: ${logPath}`);

    const db = await getDb(loaded.dataDir);
    const stats = await countStats(db);
    console.log(
      `Index: ${stats.sources} sources, ${stats.documents} documents, ${stats.chunks} chunks, ${stats.embeddings} embeddings`,
    );

    const configCheck = await validateConfigFile(loaded.configPath);
    const checks: Array<[string, boolean, string]> = [
      ["config schema", configCheck.ok, configCheck.detail],
      ["log file", logPath != null && (await exists(logPath)), logPath ?? "—"],
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
      if (!ok) log.warn(`doctor check failed: ${name} — ${detail}`);
    }

    console.log(`Embeddings provider: ${loaded.config.embeddings.provider}`);
    console.log(
      `Rerank: ${loaded.config.rerank.enabled ? loaded.config.rerank.provider : "disabled"}`,
    );
    console.log(`Playwright mode: ${loaded.config.crawl.playwright}`);
    console.log(`Log level: ${loaded.config.log.level}`);
    log.info("doctor complete");
    console.log(chalk.green("Doctor complete."));
  },
});
