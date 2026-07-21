import { homedir } from "node:os";
import { join } from "node:path";

export function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") return homedir();
  return path;
}

export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "localdoc", "config.yml");
  return join(homedir(), ".config", "localdoc", "config.yml");
}

export function defaultDataDir(): string {
  return join(homedir(), ".localdoc");
}

export function resolveConfigPath(override?: string): string {
  return expandHome(override ?? process.env.LOCALDOC_CONFIG ?? defaultConfigPath());
}
