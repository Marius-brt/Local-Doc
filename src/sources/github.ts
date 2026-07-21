import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocaldocConfig } from "../config/schema.ts";
import { buildFetchInit } from "../crawl/fetch.ts";
import { collectFolderFiles, type FolderFile } from "./folder.ts";

export function parseGithubUrl(input: string): {
  owner: string;
  repo: string;
  ref?: string;
} | null {
  // github:owner/repo or https://github.com/owner/repo
  const cleaned = input.replace(/\.git$/, "");
  const m =
    cleaned.match(
      /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:\/(?:tree|blob)\/([^/]+))?/i,
    ) || cleaned.match(/^github:([^/]+)\/([^@]+)(?:@(.+))?$/i);
  if (!m) return null;
  return {
    owner: m[1]!,
    repo: m[2]!.replace(/\.git$/, ""),
    ref: m[3],
  };
}

export function isGithubInput(input: string): boolean {
  return Boolean(parseGithubUrl(input));
}

export async function collectGithubFiles(
  input: string,
): Promise<{ rootUri: string; title: string; files: FolderFile[] }> {
  const parsed = parseGithubUrl(input);
  if (!parsed) throw new Error(`Not a GitHub URL: ${input}`);

  const rootUri = `https://github.com/${parsed.owner}/${parsed.repo}`;
  const title = `${parsed.owner}/${parsed.repo}`;
  const tmp = await mkdtemp(join(tmpdir(), "localdoc-gh-"));

  try {
    const cloneUrl = `${rootUri}.git`;
    const args = ["clone", "--depth", "1", "--filter=blob:none", "--sparse"];
    if (parsed.ref) {
      args.push("--branch", parsed.ref);
    }
    args.push(cloneUrl, tmp);

    const proc = Bun.spawn(["git", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`git clone failed: ${err || `exit ${code}`}`);
    }

    // sparse-checkout docs + readme
    const sparse = Bun.spawn(
      [
        "git",
        "-C",
        tmp,
        "sparse-checkout",
        "set",
        "--cone",
        "README.md",
        "README.MD",
        "README",
        "docs",
        "doc",
        "documentation",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await sparse.exited;

    // Also try to include common readme variants via API fallback listing
    const files = await collectFolderFiles(tmp);
    // Prefer README + docs; if sparse left little, collect all text from clone
    const filtered = files.filter((f) => {
      const lower = f.path.toLowerCase();
      return (
        lower.includes("/docs/") ||
        lower.includes("/doc/") ||
        lower.includes("/documentation/") ||
        /readme(\.|$)/i.test(lower)
      );
    });
    return {
      rootUri,
      title,
      files: filtered.length > 0 ? filtered : files,
    };
  } finally {
    // Keep tmp until caller reads — actually we already read files into memory
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Download raw file list via GitHub API (no git) as fallback. */
export async function collectGithubViaApi(
  input: string,
  config?: LocaldocConfig,
  signal?: AbortSignal,
): Promise<{ rootUri: string; title: string; files: FolderFile[] }> {
  const parsed = parseGithubUrl(input);
  if (!parsed) throw new Error(`Not a GitHub URL: ${input}`);
  const rootUri = `https://github.com/${parsed.owner}/${parsed.repo}`;
  const title = `${parsed.owner}/${parsed.repo}`;
  const apiBase = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;

  const treeUrl = `${apiBase}/git/trees/${parsed.ref ?? "HEAD"}?recursive=1`;
  const treeInit = config
    ? buildFetchInit(config, {
        url: treeUrl,
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "localdoc",
        },
      })
    : {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "localdoc",
        },
        signal,
      };

  const treeRes = await fetch(treeUrl, treeInit);
  if (!treeRes.ok) {
    throw new Error(`GitHub API tree failed: HTTP ${treeRes.status}`);
  }
  const tree = (await treeRes.json()) as {
    tree?: Array<{ path: string; type: string; size?: number }>;
  };
  const paths = (tree.tree ?? [])
    .filter(
      (t) =>
        t.type === "blob" &&
        (/(^|\/)README(\.|$)/i.test(t.path) ||
          t.path.startsWith("docs/") ||
          t.path.startsWith("doc/") ||
          /\.(md|mdx|txt|rst|html)$/i.test(t.path)) &&
        (t.size ?? 0) < 1_000_000,
    )
    .slice(0, 500);

  const files: FolderFile[] = [];
  for (const item of paths) {
    if (signal?.aborted) {
      const err = new Error("Cancelled");
      err.name = "AbortError";
      throw err;
    }
    const rawUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.ref ?? "HEAD"}/${item.path}`;
    const fileInit = config
      ? buildFetchInit(config, {
          url: rawUrl,
          signal,
          headers: { "User-Agent": "localdoc" },
        })
      : { headers: { "User-Agent": "localdoc" }, signal };
    const res = await fetch(rawUrl, fileInit);
    if (!res.ok) continue;
    const content = await res.text();
    files.push({
      path: item.path,
      uri: `${rootUri}/blob/HEAD/${item.path}`,
      content,
    });
  }
  return { rootUri, title, files };
}
