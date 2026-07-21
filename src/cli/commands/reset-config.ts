import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { defineCommand } from "citty";
import { resetConfig } from "../../config/load.ts";
import { resolveConfigPath } from "../../util/paths.ts";

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export default defineCommand({
  meta: {
    name: "reset-config",
    description: "Overwrite config.yml with built-in defaults (index/data untouched)",
  },
  args: {
    yes: {
      type: "boolean",
      description: "Skip confirmation",
      alias: "y",
      default: false,
    },
    config: { type: "string", description: "Path to config.yml", alias: "c" },
  },
  async run({ args }) {
    const configPath = resolveConfigPath(args.config);

    if (!args.yes) {
      if (!process.stdin.isTTY) {
        console.error(chalk.red("Refusing to reset config without --yes in non-interactive mode."));
        process.exitCode = 1;
        return;
      }
      const ok = await confirm(`Reset ${configPath} to defaults?`);
      if (!ok) {
        console.log("Aborted.");
        return;
      }
    }

    const { existed } = await resetConfig(args.config);
    console.log(
      chalk.green(
        existed ? `Reset config to defaults: ${configPath}` : `Wrote default config: ${configPath}`,
      ),
    );
    console.log(chalk.dim("Index and data dir were not modified."));
  },
});
