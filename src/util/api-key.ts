/**
 * Resolve an API key config value.
 * - `$ENV_NAME` → `process.env.ENV_NAME`
 * - anything else → used as the literal key
 */
export function resolveApiKey(value: string, label = "API key"): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Missing ${label}`);
  }
  if (trimmed.startsWith("$")) {
    const envName = trimmed.slice(1);
    if (!envName) {
      throw new Error(`Invalid ${label}: empty env var name after $`);
    }
    const fromEnv = process.env[envName];
    if (!fromEnv) {
      throw new Error(`Missing env var ${envName} for ${label}`);
    }
    return fromEnv;
  }
  return trimmed;
}

/** Normalize legacy `api_key_env: NAME` into `api_key: $NAME`. */
export function migrateApiKeyFields(
  raw: Record<string, unknown>,
  keyField = "api_key",
  legacyField = "api_key_env",
): Record<string, unknown> {
  if (raw[keyField] == null && typeof raw[legacyField] === "string") {
    const legacy = String(raw[legacyField]);
    raw[keyField] = legacy.startsWith("$") ? legacy : `$${legacy}`;
  }
  return raw;
}
