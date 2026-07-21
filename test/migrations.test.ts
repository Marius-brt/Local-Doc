import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db/migrations.ts";

describe("migrations registry", () => {
  test("registers every prisma migration folder", async () => {
    const dir = join(import.meta.dir, "..", "prisma", "migrations");
    const entries = await readdir(dir, { withFileTypes: true });
    const onDisk = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const registered = MIGRATIONS.map((m) => m.name).sort();
    expect(registered).toEqual(onDisk);
  });

  test("imported SQL is non-empty", () => {
    for (const m of MIGRATIONS) {
      expect(m.sql.length).toBeGreaterThan(100);
      expect(m.sql).toContain("CREATE TABLE");
    }
  });
});
