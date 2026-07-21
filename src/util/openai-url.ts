/**
 * Normalize OpenAI-compatible API base URLs.
 * Host-only URLs (common for LM Studio / local servers) get `/v1` appended.
 * Paths that already include a version or custom prefix are left unchanged.
 */
export function normalizeOpenAICompatibleBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  try {
    const u = new URL(trimmed);
    const path = u.pathname.replace(/\/+$/, "");
    if (path === "" || path === "/") {
      u.pathname = "/v1";
      return u.toString().replace(/\/+$/, "");
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}
