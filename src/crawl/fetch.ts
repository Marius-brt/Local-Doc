import pRetry from "p-retry";
import type { LocaldocConfig } from "../config/schema.ts";
import { resolveProxyUrl } from "../util/proxy.ts";
import { type FetchScope, urlInFetchScope } from "./urls.ts";

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
    url?: string;
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

  const target = opts.url ?? "";
  const proxyUrl = target
    ? resolveProxyUrl(config.http.proxy, target)
    : (config.http.proxy.url ?? undefined);
  if (proxyUrl) {
    init.proxy = proxyUrl;
  }
  if (!config.http.proxy.reject_unauthorized) {
    init.tls = { rejectUnauthorized: false };
  }
  return init;
}

function resolveRedirectUrl(current: string, location: string): string | null {
  try {
    return new URL(location, current).toString();
  } catch {
    return null;
  }
}

async function fetchOnce(
  url: string,
  config: LocaldocConfig,
  signal: AbortSignal | undefined,
  redirect: RequestRedirect,
): Promise<Response> {
  return fetch(url, buildFetchInit(config, { url, signal, redirect }));
}

/**
 * Fetch text. When `scope` is set, redirects are followed manually and only
 * when each hop stays in scope (blocks SSRF via redirect / off-site locs).
 */
export async function fetchText(
  url: string,
  config: LocaldocConfig,
  signal?: AbortSignal,
  scope?: FetchScope,
): Promise<FetchResult> {
  try {
    const result = await pRetry(
      async () => {
        if (signal?.aborted) {
          const err = new Error("Cancelled");
          err.name = "AbortError";
          throw err;
        }

        if (scope && !urlInFetchScope(url, scope)) {
          return {
            ok: false,
            status: 0,
            url,
            body: "",
            contentType: "",
            error: `URL out of crawl scope: ${url}`,
          } satisfies FetchResult;
        }

        if (!scope) {
          const res = await fetchOnce(url, config, signal, "follow");
          const body = await res.text();
          return {
            ok: res.ok,
            status: res.status,
            url: res.url || url,
            body,
            contentType: res.headers.get("content-type") ?? "",
            error: res.ok ? undefined : `HTTP ${res.status}`,
          } satisfies FetchResult;
        }

        const maxRedirects = 10;
        let current = url;
        for (let hop = 0; hop <= maxRedirects; hop++) {
          if (!urlInFetchScope(current, scope)) {
            return {
              ok: false,
              status: 0,
              url: current,
              body: "",
              contentType: "",
              error: `redirect left crawl scope: ${current}`,
            } satisfies FetchResult;
          }
          const res = await fetchOnce(current, config, signal, "manual");
          if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            if (!location) {
              return {
                ok: false,
                status: res.status,
                url: current,
                body: "",
                contentType: "",
                error: `HTTP ${res.status} redirect without Location`,
              } satisfies FetchResult;
            }
            const next = resolveRedirectUrl(current, location);
            if (!next) {
              return {
                ok: false,
                status: res.status,
                url: current,
                body: "",
                contentType: "",
                error: `invalid redirect Location: ${location}`,
              } satisfies FetchResult;
            }
            current = next;
            continue;
          }
          const body = await res.text();
          return {
            ok: res.ok,
            status: res.status,
            url: res.url || current,
            body,
            contentType: res.headers.get("content-type") ?? "",
            error: res.ok ? undefined : `HTTP ${res.status}`,
          } satisfies FetchResult;
        }
        return {
          ok: false,
          status: 0,
          url: current,
          body: "",
          contentType: "",
          error: "too many redirects",
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
  scope?: FetchScope,
): Promise<string | null> {
  const res = await fetchText(url, config, signal, scope);
  if (!res.ok || !res.body.trim()) return null;
  return res.body;
}
