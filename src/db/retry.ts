import type { Client, InStatement } from "@libsql/client";
import pRetry, { AbortError } from "p-retry";
import { log } from "../util/log.ts";

const BUSY_RE = /SQLITE_BUSY|database is locked|busy/i;

export function isDbBusyError(err: unknown): boolean {
  if (err == null) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (BUSY_RE.test(msg)) return true;
  const code = (err as { code?: string }).code;
  return typeof code === "string" && BUSY_RE.test(code);
}

/**
 * Retry a DB operation on transient lock contention (multi-process writers).
 * Non-busy errors fail immediately.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts: { label?: string; retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 8;
  const label = opts.label ?? "db";
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (err) {
        if (isDbBusyError(err)) throw err;
        throw new AbortError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    {
      retries,
      minTimeout: 50,
      maxTimeout: 2000,
      factor: 2,
      onFailedAttempt: (info) => {
        log.warn(
          `${label}: database busy (attempt ${info.attemptNumber}/${retries + 1}), retrying…`,
        );
      },
    },
  );
}

/** Wrap a libSQL client so execute / executeMultiple / batch / transaction retry on SQLITE_BUSY. */
export function wrapClientWithBusyRetry(client: Client): Client {
  const execute = ((stmt: InStatement) =>
    withDbRetry(() => client.execute(stmt), { label: "execute" })) as Client["execute"];

  const executeMultiple = ((sql: string) =>
    withDbRetry(() => client.executeMultiple(sql), {
      label: "executeMultiple",
    })) as Client["executeMultiple"];

  const batch = ((...args: Parameters<Client["batch"]>) =>
    withDbRetry(() => client.batch(...args), { label: "batch" })) as Client["batch"];

  const transaction = ((...args: Parameters<Client["transaction"]>) =>
    withDbRetry(() => client.transaction(...args), {
      label: "transaction",
    })) as Client["transaction"];

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "execute") return execute;
      if (prop === "executeMultiple") return executeMultiple;
      if (prop === "batch") return batch;
      if (prop === "transaction") return transaction;
      return Reflect.get(target, prop, receiver);
    },
  }) as Client;
}
