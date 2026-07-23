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

/** True when `url` shares scheme+host+port with `root`. */
export function isSameOrigin(url: string, root: string): boolean {
  try {
    return new URL(normalizeUrl(url)).origin === new URL(normalizeUrl(root)).origin;
  } catch {
    return false;
  }
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

/** Crawl fetch scope: path-bounded pages vs same-origin discovery artifacts. */
export type FetchScope =
  | { mode: "under-root"; root: string }
  | { mode: "same-origin"; root: string };

export function urlInFetchScope(url: string, scope: FetchScope): boolean {
  if (scope.mode === "under-root") return isUnderRoot(url, scope.root);
  return isSameOrigin(url, scope.root);
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

/**
 * Common docs locale path segments (`/docs/zh/...`, `/en-US/docs/...`).
 * Excludes ambiguous tech tokens (e.g. `go`) that match ISO-looking shapes.
 */
const DOC_LOCALES = new Set([
  "en",
  "en-us",
  "en-gb",
  "en-au",
  "en-ca",
  "en-nz",
  "en-ie",
  "zh",
  "zh-cn",
  "zh-tw",
  "zh-hk",
  "zh-hans",
  "zh-hant",
  "ja",
  "jp",
  "ko",
  "kr",
  "fr",
  "de",
  "es",
  "pt",
  "pt-br",
  "pt-pt",
  "ru",
  "it",
  "nl",
  "pl",
  "tr",
  "ar",
  "he",
  "hi",
  "th",
  "vi",
  "id",
  "ms",
  "sv",
  "da",
  "fi",
  "no",
  "nb",
  "nn",
  "cs",
  "sk",
  "uk",
  "ro",
  "hu",
  "el",
  "bg",
  "hr",
  "sr",
  "sl",
  "lt",
  "lv",
  "et",
  "fa",
  "bn",
  "ta",
  "te",
  "ca",
  "eu",
  "gl",
  "af",
  "sw",
  "fil",
  "tl",
]);

const ENGLISH_LOCALES = new Set(["en", "en-us", "en-gb", "en-au", "en-ca", "en-nz", "en-ie"]);

/** Tech / product path segments that look like locale tags but are not. */
const AMBIGUOUS_LOCALE_SEGMENTS = new Set(["go", "io", "js", "ts", "md", "rs", "py"]);

function normalizeLocaleTag(segment: string): string {
  return segment.replace(/_/g, "-").toLowerCase();
}

/** True when a path segment is a docs locale tag (`zh`, `en-US`, `zh_CN`). */
export function isLocaleSegment(segment: string): boolean {
  const tag = normalizeLocaleTag(segment);
  if (AMBIGUOUS_LOCALE_SEGMENTS.has(tag.split("-")[0]!)) return false;
  return DOC_LOCALES.has(tag);
}

/** Strip a single locale segment from a pathname. */
export function stripLocalePath(pathname: string): {
  unlocalizedPath: string;
  locale: string | null;
} {
  const parts = pathname.split("/").filter(Boolean);
  const idx = parts.findIndex((p) => isLocaleSegment(p));
  if (idx < 0) return { unlocalizedPath: pathname || "/", locale: null };
  const locale = parts[idx]!;
  const rest = [...parts.slice(0, idx), ...parts.slice(idx + 1)];
  return {
    unlocalizedPath: rest.length ? `/${rest.join("/")}` : "/",
    locale,
  };
}

function unlocalizedKey(url: string): string {
  const u = new URL(normalizeUrl(url));
  const { unlocalizedPath } = stripLocalePath(u.pathname);
  u.pathname = unlocalizedPath;
  return u.toString();
}

/** Lower is better: unlocalized > English locale > other locales. */
function localePreference(url: string): number {
  try {
    const { locale } = stripLocalePath(new URL(normalizeUrl(url)).pathname);
    if (locale == null) return 0;
    if (ENGLISH_LOCALES.has(normalizeLocaleTag(locale))) return 1;
    return 2;
  } catch {
    return 2;
  }
}

/**
 * Prefer English / unlocalized docs URLs when the same page also exists under
 * `/docs/:lang/...` (or `/:lang/docs/...`) in the discovery set.
 */
export function dedupeLocalizedUrls(urls: string[]): string[] {
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
      key = unlocalizedKey(url);
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
    let best = Number.POSITIVE_INFINITY;
    for (const u of group) best = Math.min(best, localePreference(u));
    const preferred = group.filter((u) => localePreference(u) === best);
    // Stable: shortest path among equally preferred (unlocalized beats /en/...).
    preferred.sort((a, b) => {
      try {
        return new URL(a).pathname.length - new URL(b).pathname.length;
      } catch {
        return a.length - b.length;
      }
    });
    out.push(preferred[0]!);
  }
  return out;
}

/** True when the URL path embeds a non-English docs locale segment. */
export function isNonEnglishLocaleUrl(url: string): boolean {
  return localePreference(url) >= 2;
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
