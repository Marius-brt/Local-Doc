import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { isTextDocPath } from "../chunk/index.ts";
import { pathToUri } from "../util/file-uri.ts";

const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/target/**",
  "**/vendor/**",
  "**/*.min.js",
  "**/*.map",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/pnpm-lock.yaml",
];

export interface FolderFile {
  path: string;
  uri: string;
  content: string;
}

export async function collectFolderFiles(root: string): Promise<FolderFile[]> {
  const patterns = [
    "**/*.{md,mdx,txt,rst,html,htm,markdown}",
    "**/*.{js,jsx,ts,tsx,py,go,rs,java,kt,rb,php,c,cpp,h,cs,swift,scala,sh,bash,sql,r,lua}",
  ];
  const entries = await fg(patterns, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    dot: false,
    ignore: IGNORE,
  });

  const files: FolderFile[] = [];
  for (const abs of entries) {
    if (!isTextDocPath(abs)) continue;
    const content = await readFile(abs, "utf8").catch(() => null);
    if (content == null) continue;
    if (content.length > 2_000_000) continue;
    files.push({
      path: abs,
      uri: pathToUri(abs),
      content,
    });
  }
  return files;
}
