import chalk from "chalk";
import { defineCommand } from "citty";
import {
  AGENTS,
  type AgentId,
  DEFAULT_AGENTS,
  installLocaldocSkill,
} from "../../skills/install.ts";

export default defineCommand({
  meta: {
    name: "install-skill",
    description:
      "Install the localdoc skill for Cursor, Claude Code, Codex, OpenCode, Antigravity, and more",
  },
  args: {
    agent: {
      type: "string",
      description: `Agents to target (comma-separated). Default: ${DEFAULT_AGENTS.join(",")}. Available: ${Object.keys(AGENTS).join(",")}`,
      alias: "a",
    },
    path: {
      type: "string",
      description: "Install to a custom skills directory instead of agent defaults",
    },
    project: {
      type: "boolean",
      description: "Install into the current project instead of global home dirs",
      default: false,
    },
    "no-skills-cli": {
      type: "boolean",
      description: "Skip Vercel skills CLI; write SKILL.md files directly",
      default: false,
    },
  },
  async run({ args }) {
    const agents = args.agent
      ? String(args.agent)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            if (!(s in AGENTS)) {
              throw new Error(`Unknown agent "${s}". Available: ${Object.keys(AGENTS).join(", ")}`);
            }
            return s as AgentId;
          })
      : undefined;

    console.log(
      chalk.dim(
        "Uses the open skills ecosystem (https://github.com/vercel-labs/skills) when available.",
      ),
    );

    const { paths, method } = await installLocaldocSkill({
      agents,
      path: args.path,
      global: !args.project,
      useSkillsCli: !args["no-skills-cli"],
    });

    console.log(chalk.green(`Installed localdoc skill (${method}) → ${paths.length} location(s)`));
    for (const p of paths) {
      console.log(`  ${p}`);
    }
  },
});
