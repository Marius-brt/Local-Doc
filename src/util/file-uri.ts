import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Convert a filesystem path to a `file://` URI. */
export function pathToUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/**
 * If `input` is a `file://` URI, return the filesystem path.
 * Otherwise return null.
 */
export function tryFileUriToPath(input: string): string | null {
  const trimmed = input.trim();
  if (!/^file:/i.test(trimmed)) return null;
  try {
    return fileURLToPath(trimmed);
  } catch {
    // Tolerate slightly malformed URIs such as `file:/path` or unencoded spaces.
    const stripped = trimmed.replace(/^file:\/\//i, "").replace(/^file:/i, "");
    if (!stripped) return null;
    return stripped.startsWith("/") ? stripped : `/${stripped}`;
  }
}

/** Resolve a folder target that may be a path or a `file://` URI. */
export function resolveFolderPath(input: string, cwd = process.cwd()): string {
  const fromUri = tryFileUriToPath(input);
  const path = fromUri ?? input;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Human-readable URI/path for UI (file:// → path, `%20` → space). */
export function formatUriForDisplay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const fromFile = tryFileUriToPath(trimmed);
  if (fromFile) return fromFile;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}
