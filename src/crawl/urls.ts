/** Canonicalize http(s) URLs for indexing / discovery. */
export function normalizeUrl(url: string): string {
  const u = new URL(url);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  let path = u.pathname.replace(/\/index\.html?$/i, "/");
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  u.pathname = path || "/";
  // Drop common tracking params
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

/** True when `url` is under the path prefix of `root` (same origin). */
export function isUnderRoot(url: string, root: string): boolean {
  let u: URL;
  let r: URL;
  try {
    u = new URL(normalizeUrl(url));
    r = new URL(normalizeUrl(root));
  } catch {
    return false;
  }
  if (u.origin !== r.origin) return false;
  const rootPath = r.pathname === "/" ? "" : r.pathname.replace(/\/$/, "");
  if (!rootPath) return true;
  return u.pathname === rootPath || u.pathname.startsWith(`${rootPath}/`);
}

const VERSION_SEGMENT = /^(v?\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?|latest|stable|master|main)$/i;

/** Strip a single version/latest segment from a pathname. */
export function stripVersionPath(pathname: string): {
  unversionedPath: string;
  version: string | null;
} {
  const parts = pathname.split("/").filter(Boolean);
  const idx = parts.findIndex((p) => VERSION_SEGMENT.test(p));
  if (idx < 0) return { unversionedPath: pathname || "/", version: null };
  const version = parts[idx]!;
  const rest = [...parts.slice(0, idx), ...parts.slice(idx + 1)];
  return {
    unversionedPath: rest.length ? `/${rest.join("/")}` : "/",
    version,
  };
}

function unversionedKey(url: string): string {
  const u = new URL(normalizeUrl(url));
  const { unversionedPath } = stripVersionPath(u.pathname);
  u.pathname = unversionedPath;
  return u.toString();
}

/**
 * Prefer unversioned / canonical URLs when both versioned and unversioned
 * variants of the same page exist in the discovery set.
 */
export function dedupeVersionedUrls(urls: string[]): string[] {
  const normalized = [
    ...new Set(
      urls.map((u) => {
        try {
          return normalizeUrl(u);
        } catch {
          return u;
        }
      }),
    ),
  ];

  const groups = new Map<string, string[]>();
  for (const url of normalized) {
    let key: string;
    try {
      key = unversionedKey(url);
    } catch {
      key = url;
    }
    const list = groups.get(key) ?? [];
    list.push(url);
    groups.set(key, list);
  }

  const out: string[] = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    // Prefer URL whose path has no version segment
    const unversioned = group.find((u) => {
      try {
        return stripVersionPath(new URL(u).pathname).version == null;
      } catch {
        return false;
      }
    });
    if (unversioned) {
      out.push(unversioned);
      continue;
    }
    // Prefer "latest" / "stable" over numeric versions
    const latest = group.find((u) => {
      try {
        const v = stripVersionPath(new URL(u).pathname).version;
        return v != null && /^(latest|stable)$/i.test(v);
      } catch {
        return false;
      }
    });
    out.push(latest ?? group[0]!);
  }
  return out;
}

export function filterUrlsForRoot(urls: string[], root: string): string[] {
  return urls.filter((u) => {
    try {
      return isUnderRoot(u, root);
    } catch {
      return false;
    }
  });
}

/** Detect version segment for metadata when keeping a versioned URL. */
export function detectUrlVersion(url: string): string | null {
  try {
    return stripVersionPath(new URL(normalizeUrl(url)).pathname).version;
  } catch {
    return null;
  }
}

export function isHtmlContentType(contentType: string | undefined | null): boolean {
  if (!contentType) return true; // unknown — allow and let extract decide
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  if (!ct) return true;
  if (ct.includes("html")) return true;
  if (ct.startsWith("text/plain")) return true; // llms.txt etc.
  if (ct.startsWith("text/markdown")) return true;
  return false;
}

export function isSkippableContentType(contentType: string | undefined | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  if (!ct) return false;
  if (ct.includes("json")) return true;
  if (ct.includes("xml") && !ct.includes("xhtml")) return true;
  if (ct.startsWith("image/") || ct.startsWith("audio/") || ct.startsWith("video/")) return true;
  if (ct === "application/pdf" || ct === "application/octet-stream") return true;
  if (ct.includes("javascript") || ct.includes("wasm")) return true;
  return false;
}
