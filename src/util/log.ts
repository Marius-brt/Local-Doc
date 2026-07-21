import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { expandHome } from "./paths.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let minLevel: LogLevel = "info";
let logFilePath: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();

/** Redact bearer tokens, API keys, and long opaque secrets from log lines. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Authorization:\s*Bearer\s+)(\S+)/gi, "$1***")
    .replace(/(Bearer\s+)([A-Za-z0-9._\-+/=]{8,})/g, "$1***")
    .replace(
      /\b(api[_-]?key|token|secret|password)\b([=:]\s*)(["']?)([^\s"'\\]{6,})\3/gi,
      "$1$2$3***$3",
    )
    .replace(/\b(sk-[A-Za-z0-9]{10,}|sk-proj-[A-Za-z0-9_-]{10,}|co_[A-Za-z0-9]{10,})\b/g, "***");
}

function formatLine(level: LogLevel, message: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase()}] ${redactSecrets(message)}\n`;
}

function enqueueWrite(line: string): void {
  if (!logFilePath) return;
  const path = logFilePath;
  writeQueue = writeQueue
    .then(() => appendFile(path, line, { encoding: "utf8", mode: 0o600 }))
    .catch((err) => {
      // Avoid recursive logging; surface once on stderr.
      console.error(
        `[localdoc] failed to write log: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

function emit(level: LogLevel, message: string, mirrorStderr: boolean): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const line = formatLine(level, message);
  enqueueWrite(line);
  if (mirrorStderr) {
    console.error(line.trimEnd());
  }
}

/** Wait for pending log writes to finish. */
export async function flushLog(): Promise<void> {
  await writeQueue;
}

/** Best-effort string for logging thrown values (incl. AI SDK response bodies). */
export function formatError(err: unknown): string {
  if (err == null) return String(err);
  if (typeof err === "string") return redactSecrets(err);
  if (err instanceof Error) {
    const parts = [err.message];
    const extra = err as Error & {
      cause?: unknown;
      statusCode?: number;
      responseBody?: string;
      url?: string;
      data?: unknown;
      text?: string;
    };
    if (extra.statusCode != null) parts.push(`status=${extra.statusCode}`);
    if (extra.url) parts.push(`url=${extra.url}`);
    if (extra.responseBody) {
      parts.push(`body=${String(extra.responseBody).slice(0, 200)}`);
    } else if (typeof extra.text === "string" && extra.text) {
      parts.push(`body=${extra.text.slice(0, 200)}`);
    } else if (extra.data != null) {
      try {
        parts.push(`data=${JSON.stringify(extra.data).slice(0, 200)}`);
      } catch {
        // ignore
      }
    }
    if (extra.cause != null) parts.push(`cause=${formatError(extra.cause)}`);
    return redactSecrets(parts.join(" | "));
  }
  try {
    return redactSecrets(JSON.stringify(err));
  } catch {
    return redactSecrets(String(err));
  }
}

/** Resolved log file path, or null if logging is not initialized. */
export function getLogPath(): string | null {
  return logFilePath;
}

/**
 * Initialize file logging under the data directory.
 * Default file: `<dataDir>/logs/localdoc.log`
 * Returns the log path, or null if the file could not be created.
 */
export async function initLog(options: {
  dataDir: string;
  level?: LogLevel;
  /** Absolute path, `~/…`, or path relative to dataDir. null → default. */
  file?: string | null;
}): Promise<string | null> {
  minLevel = options.level ?? "info";
  const relativeOrAbs = options.file?.trim() || "logs/localdoc.log";
  const expanded = expandHome(relativeOrAbs);
  const path = isAbsolute(expanded) ? expanded : join(options.dataDir, expanded);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    logFilePath = path;
    enqueueWrite(formatLine("info", `——— localdoc session start (level=${minLevel}) ———`));
    return logFilePath;
  } catch (err) {
    logFilePath = null;
    console.error(
      `[localdoc] logging disabled (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

export const log = {
  debug(message: string): void {
    emit("debug", message, false);
  },
  info(message: string): void {
    emit("info", message, false);
  },
  warn(message: string): void {
    emit("warn", message, false);
  },
  /** Writes to the log file and mirrors to stderr. */
  error(message: string): void {
    emit("error", message, true);
  },
};
