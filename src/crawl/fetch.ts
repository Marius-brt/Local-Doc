import pRetry from "p-retry";
import type { LocaldocConfig } from "../config/schema.ts";

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string;
  body: string;
  contentType: string;
  error?: string;
}

function mergeHeaders(
  config: LocaldocConfig,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    "User-Agent": "localdoc/0.1 (+https://github.com/Marius-brt/Local-Doc; docs indexer)",
    Accept: "text/html,application/xhtml+xml,text/plain,*/*;q=0.8",
    ...config.http.headers,
    ...config.crawl.headers,
    ...extra,
  };
}

/** Shared Bun fetch options: proxy covers http + https targets; optional TLS skip. */
export function buildFetchInit(
  config: LocaldocConfig,
  opts: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    redirect?: RequestRedirect;
  } = {},
): RequestInit & { proxy?: string; tls?: { rejectUnauthorized: boolean } } {
  const timeoutMs = opts.timeoutMs ?? config.crawl.timeout_ms;
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (opts.signal) signals.push(opts.signal);

  const init: RequestInit & { proxy?: string; tls?: { rejectUnauthorized: boolean } } = {
    headers: mergeHeaders(config, opts.headers),
    signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals),
    redirect: opts.redirect ?? "follow",
  };

  if (config.http.proxy) {
    init.proxy = config.http.proxy;
  }
  if (!config.http.reject_unauthorized) {
    init.tls = { rejectUnauthorized: false };
  }
  return init;
}

export async function fetchText(
  url: string,
  config: LocaldocConfig,
  signal?: AbortSignal,
): Promise<FetchResult> {
  try {
    const result = await pRetry(
      async () => {
        if (signal?.aborted) {
          const err = new Error("Cancelled");
          err.name = "AbortError";
          throw err;
        }
        const res = await fetch(url, buildFetchInit(config, { signal }));
        const body = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          url: res.url || url,
          body,
          contentType: res.headers.get("content-type") ?? "",
          error: res.ok ? undefined : `HTTP ${res.status}`,
        } satisfies FetchResult;
      },
      {
        retries: config.http.retries,
        shouldRetry: ({ error }) => !(error instanceof Error && error.name === "AbortError"),
        onFailedAttempt: () => {},
      },
    );
    return result;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        status: 0,
        url,
        body: "",
        contentType: "",
        error: "Cancelled",
      };
    }
    return {
      ok: false,
      status: 0,
      url,
      body: "",
      contentType: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchOptional(
  url: string,
  config: LocaldocConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetchText(url, config, signal);
  if (!res.ok || !res.body.trim()) return null;
  return res.body;
}
