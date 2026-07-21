import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { SKILL_MARKDOWN } from "./content.ts";

/**
 * Agent install paths aligned with Vercel Labs `skills` CLI
 * https://github.com/vercel-labs/skills
 */
export const AGENTS = {
  cursor: {
    id: "cursor",
    label: "Cursor",
    skillsCliId: "cursor",
    globalDir: () => join(homedir(), ".cursor", "skills"),
    projectDir: () => join(process.cwd(), ".cursor", "skills"),
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    skillsCliId: "claude-code",
    globalDir: () => join(homedir(), ".claude", "skills"),
    projectDir: () => join(process.cwd(), ".claude", "skills"),
  },
  codex: {
    id: "codex",
    label: "Codex",
    skillsCliId: "codex",
    globalDir: () => join(homedir(), ".codex", "skills"),
    projectDir: () => join(process.cwd(), ".codex", "skills"),
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    skillsCliId: "opencode",
    globalDir: () => join(homedir(), ".config", "opencode", "skills"),
    projectDir: () => join(process.cwd(), ".opencode", "skills"),
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    skillsCliId: "antigravity",
    globalDir: () => join(homedir(), ".gemini", "antigravity", "skills"),
    projectDir: () => join(process.cwd(), ".agent", "skills"),
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    skillsCliId: "gemini-cli",
    globalDir: () => join(homedir(), ".gemini", "skills"),
    projectDir: () => join(process.cwd(), ".gemini", "skills"),
  },
  windsurf: {
    id: "windsurf",
    label: "Windsurf",
    skillsCliId: "windsurf",
    globalDir: () => join(homedir(), ".codeium", "windsurf", "skills"),
    projectDir: () => join(process.cwd(), ".windsurf", "skills"),
  },
  agents: {
    id: "agents",
    label: "Open agents standard (~/.agents)",
    skillsCliId: null as string | null,
    globalDir: () => join(homedir(), ".agents", "skills"),
    projectDir: () => join(process.cwd(), ".agents", "skills"),
  },
} as const;

export type AgentId = keyof typeof AGENTS;

export const DEFAULT_AGENTS: AgentId[] = [
  "cursor",
  "claude-code",
  "codex",
  "opencode",
  "antigravity",
  "agents",
];

export interface InstallSkillOptions {
  agents?: AgentId[];
  global?: boolean;
  path?: string;
  useSkillsCli?: boolean;
}

async function writeSkillToDir(baseSkillsDir: string): Promise<string> {
  const dir = join(baseSkillsDir, "localdoc");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  await writeFile(file, SKILL_MARKDOWN, "utf8");
  return file;
}

export async function installSkillViaSkillsCli(
  agents: AgentId[],
  global: boolean,
): Promise<{ ok: boolean; detail: string }> {
  const cliAgents = agents
    .map((id) => AGENTS[id]?.skillsCliId)
    .filter((id): id is string => Boolean(id));

  if (cliAgents.length === 0) {
    return { ok: false, detail: "no skills-CLI-compatible agents selected" };
  }

  const staging = await mkdtemp(join(tmpdir(), "localdoc-skill-"));
  try {
    const skillDir = join(staging, "localdoc");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MARKDOWN, "utf8");

    const args = ["skills", "add", staging, "--skill", "localdoc", "--copy", "-y"];
    if (global) args.push("-g");
    for (const a of cliAgents) {
      args.push("-a", a);
    }

    const proc = Bun.spawn(["bunx", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (code === 0) {
      return { ok: true, detail: stdout.trim() || "skills CLI install ok" };
    }
    return {
      ok: false,
      detail: stderr.trim() || stdout.trim() || `skills CLI exit ${code}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export async function installSkillDirect(options: InstallSkillOptions = {}): Promise<string[]> {
  const installed: string[] = [];

  if (options.path) {
    installed.push(await writeSkillToDir(options.path));
    return installed;
  }

  const agents = options.agents?.length ? options.agents : DEFAULT_AGENTS;
  const global = options.global !== false;

  for (const id of agents) {
    const agent = AGENTS[id];
    if (!agent) continue;
    const base = global ? agent.globalDir() : agent.projectDir();
    installed.push(await writeSkillToDir(base));
  }
  return installed;
}

export async function installLocaldocSkill(
  options: InstallSkillOptions = {},
): Promise<{ paths: string[]; method: "skills-cli" | "direct" }> {
  if (options.path) {
    const paths = await installSkillDirect(options);
    return { paths, method: "direct" };
  }

  const agents = options.agents?.length ? options.agents : DEFAULT_AGENTS;
  const global = options.global !== false;
  const preferCli = options.useSkillsCli !== false;

  if (preferCli) {
    const result = await installSkillViaSkillsCli(agents, global);
    if (result.ok) {
      // Also write agents that the CLI does not cover (e.g. ~/.agents)
      const directOnly = agents.filter((id) => !AGENTS[id].skillsCliId);
      const paths = [...(await installSkillDirect({ agents: directOnly, global }))];
      // Report CLI targets as well (best-effort known paths)
      for (const id of agents) {
        if (!AGENTS[id].skillsCliId) continue;
        const base = global ? AGENTS[id].globalDir() : AGENTS[id].projectDir();
        paths.push(join(base, "localdoc", "SKILL.md"));
      }
      if (result.detail) console.log(chalk.dim(result.detail));
      return { paths, method: "skills-cli" };
    }
    console.log(
      chalk.yellow(`skills CLI unavailable (${result.detail}); writing skill files directly…`),
    );
  }

  const paths = await installSkillDirect({ ...options, agents, global });
  return { paths, method: "direct" };
}
