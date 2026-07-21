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

function mergeHeaders(config: LocaldocConfig): Record<string, string> {
  return {
    "User-Agent": "localdoc/0.1 (+https://github.com/localdoc/localdoc; docs indexer)",
    Accept: "text/html,application/xhtml+xml,text/plain,*/*;q=0.8",
    ...config.http.headers,
    ...config.crawl.headers,
  };
}

export async function fetchText(url: string, config: LocaldocConfig): Promise<FetchResult> {
  const proxy = config.crawl.proxy ?? config.http.proxy;
  try {
    const result = await pRetry(
      async () => {
        const res = await fetch(url, {
          headers: mergeHeaders(config),
          signal: AbortSignal.timeout(config.crawl.timeout_ms),
          // @ts-expect-error bun supports proxy on fetch
          proxy: proxy ?? undefined,
          redirect: "follow",
        });
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
        onFailedAttempt: () => {},
      },
    );
    return result;
  } catch (err) {
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

export async function fetchOptional(url: string, config: LocaldocConfig): Promise<string | null> {
  const res = await fetchText(url, config);
  if (!res.ok || !res.body.trim()) return null;
  return res.body;
}
