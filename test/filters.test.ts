import { describe, expect, test } from "bun:test";
import {
  buildFilterSql,
  hasSearchFilters,
  hitMatchesFilters,
  parseChunkKinds,
  splitList,
} from "../src/search/filters.ts";

describe("search filters", () => {
  test("splitList trims and drops empties", () => {
    expect(splitList("a, b , ,c")).toEqual(["a", "b", "c"]);
    expect(splitList("  ")).toEqual([]);
    expect(splitList(undefined)).toEqual([]);
  });

  test("parseChunkKinds normalizes aliases", () => {
    expect(parseChunkKinds(["text", "CODE", "table"])).toEqual(["prose", "code", "table"]);
    expect(parseChunkKinds(["markdown", "md"])).toEqual(["prose"]);
  });

  test("parseChunkKinds rejects unknown values", () => {
    expect(() => parseChunkKinds(["image"])).toThrow(/Unknown chunk kind/);
  });

  test("buildFilterSql emits predicates and args", () => {
    const { sql, args } = buildFilterSql({
      kinds: ["code"],
      sourceIds: ["abc", "def"],
      keywords: ["Bearer", "token"],
    });
    expect(sql).toContain("c.source_id IN (?, ?)");
    expect(sql).toContain("json_extract(c.meta_json, '$.kind') IN (?)");
    expect(sql).toContain("instr(lower(c.text), lower(?)) > 0");
    expect(args).toEqual(["abc", "def", "code", "Bearer", "token"]);
  });

  test("buildFilterSql is empty without filters", () => {
    expect(buildFilterSql(undefined)).toEqual({ sql: "", args: [] });
    expect(hasSearchFilters({})).toBe(false);
  });

  test("hitMatchesFilters checks source and keywords", () => {
    const hit = { sourceId: "s1", text: "Use Bearer token for auth" };
    expect(hitMatchesFilters(hit, { sourceIds: ["s1"], keywords: ["bearer", "token"] })).toBe(true);
    expect(hitMatchesFilters(hit, { sourceIds: ["other"] })).toBe(false);
    expect(hitMatchesFilters(hit, { keywords: ["missing"] })).toBe(false);
  });

  test("buildFilterSql can omit keywords for FTS path", () => {
    const { sql, args } = buildFilterSql({ kinds: ["code"], keywords: ["Bearer"] }, "c", {
      includeKeywords: false,
    });
    expect(sql).toContain("kind");
    expect(sql).not.toContain("instr");
    expect(args).toEqual(["code"]);
  });
});
