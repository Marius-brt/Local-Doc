export type ChunkKind = "prose" | "table" | "code";

export interface SearchFilters {
  /** Restrict to chunk content kinds stored in meta_json.kind. */
  kinds?: ChunkKind[];
  /** Restrict to these source ids (already resolved). */
  sourceIds?: string[];
  /** Every term must appear in the chunk text (case-insensitive). */
  keywords?: string[];
}

const KIND_ALIASES: Record<string, ChunkKind> = {
  prose: "prose",
  text: "prose",
  markdown: "prose",
  md: "prose",
  table: "table",
  code: "code",
};

/** Split a comma-separated CLI/MCP list into trimmed non-empty tokens. */
export function splitList(value: string | undefined | null): string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalize user-facing kind names (`text` → `prose`, etc.). */
export function parseChunkKinds(values: string[]): ChunkKind[] {
  const out: ChunkKind[] = [];
  for (const raw of values) {
    const mapped = KIND_ALIASES[raw.toLowerCase()];
    if (!mapped) {
      throw new Error(
        `Unknown chunk kind "${raw}". Use prose, table, or code (aliases: text, markdown).`,
      );
    }
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

export function hasSearchFilters(filters: SearchFilters | undefined): boolean {
  if (!filters) return false;
  return Boolean(
    (filters.kinds?.length ?? 0) > 0 ||
      (filters.sourceIds?.length ?? 0) > 0 ||
      (filters.keywords?.length ?? 0) > 0,
  );
}

export interface BuildFilterSqlOptions {
  /**
   * When false, omit keyword `instr` predicates (use FTS MATCH for keywords instead).
   * Default true for LIKE / vector SQL paths.
   */
  includeKeywords?: boolean;
}

/** Build `AND …` SQL predicates for chunk filters. Uses table alias `c` by default. */
export function buildFilterSql(
  filters: SearchFilters | undefined,
  alias = "c",
  options: BuildFilterSqlOptions = {},
): { sql: string; args: string[] } {
  const includeKeywords = options.includeKeywords !== false;
  if (!filters) return { sql: "", args: [] };

  const parts: string[] = [];
  const args: string[] = [];

  if (filters.sourceIds?.length) {
    parts.push(`${alias}.source_id IN (${filters.sourceIds.map(() => "?").join(", ")})`);
    args.push(...filters.sourceIds);
  }
  if (filters.kinds?.length) {
    parts.push(
      `json_extract(${alias}.meta_json, '$.kind') IN (${filters.kinds.map(() => "?").join(", ")})`,
    );
    args.push(...filters.kinds);
  }
  if (includeKeywords && filters.keywords?.length) {
    for (const kw of filters.keywords) {
      parts.push(`instr(lower(${alias}.text), lower(?)) > 0`);
      args.push(kw);
    }
  }

  if (parts.length === 0) return { sql: "", args: [] };
  return { sql: ` AND ${parts.join(" AND ")}`, args };
}

/** Keep hits that still satisfy filters (post-vector_top_k safety net). */
export function hitMatchesFilters(
  hit: { sourceId: string; text: string; kind?: string | null },
  filters: SearchFilters | undefined,
): boolean {
  if (!hasSearchFilters(filters)) return true;
  if (filters!.sourceIds?.length && !filters!.sourceIds.includes(hit.sourceId)) {
    return false;
  }
  if (filters!.kinds?.length) {
    const kind = hit.kind ?? null;
    // Legacy chunks without kind: allow through only if we cannot tell (null).
    // If kind is present and not in the allow-list, reject.
    if (kind != null && !filters!.kinds.includes(kind as ChunkKind)) {
      return false;
    }
  }
  if (filters!.keywords?.length) {
    const lower = hit.text.toLowerCase();
    for (const kw of filters!.keywords) {
      if (!lower.includes(kw.toLowerCase())) return false;
    }
  }
  return true;
}
