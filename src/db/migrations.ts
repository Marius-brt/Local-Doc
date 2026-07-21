/**
 * Register Prisma migration SQL here so Bun inlines it into the standalone binary.
 * Source of truth remains prisma/migrations/<name>/migration.sql — do not paste SQL here.
 *
 * When you add a migration with `bun run db:migrate`, import the new .sql file below.
 */
import initSql from "../../prisma/migrations/20260721120000_init/migration.sql" with {
  type: "text",
};

export const MIGRATIONS: Array<{ name: string; sql: string }> = [
  { name: "20260721120000_init", sql: initSql },
];
