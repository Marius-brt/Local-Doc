import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocaldocConfig } from "../config/schema.ts";
import { isUnderRoot } from "../crawl/urls.ts";
import { formatError, log } from "../util/log.ts";

type Browser = import("playwright").Browser;

let browserPromise: Promise<Browser> | null = null;

export type BrowserProgress = (message: string) => void;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Drain a child-process stream without writing to the TTY (keeps TUI intact). */
async function drainQuiet(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine?: (line: string) => void,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    buf += chunk;
    // Progress bars often use \r
    const parts = buf.split(/\r|\n/);
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (line) onLine?.(line.slice(0, 120));
    }
  }
  const tail = buf.trim();
  if (tail) onLine?.(tail.slice(0, 120));
  return full;
}

/** Resolve the npm Playwright CLI (`cli.js`), avoiding a Python `playwright` on PATH. */
async function resolvePlaywrightCli(): Promise<string | null> {
  try {
    const pkgUrl = await import.meta.resolve("playwright/package.json");
    const pkgPath = fileURLToPath(pkgUrl);
    return join(dirname(pkgPath), "cli.js");
  } catch {
    return null;
  }
}

export async function ensurePlaywrightBrowser(
  dataDir: string,
  onProgress?: BrowserProgress,
): Promise<string> {
  const browsersPath = join(dataDir, "browsers");
  await mkdir(browsersPath, { recursive: true });
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;

  const marker = join(browsersPath, ".localdoc-chromium-installed");
  if (!(await exists(marker))) {
    onProgress?.("Downloading Chromium for Playwright (one-time setup)…");
    log.info(`installing Playwright Chromium into ${browsersPath}`);

    const cli = await resolvePlaywrightCli();
    const cmd = cli
      ? ["bun", cli, "install", "chromium"]
      : ["bunx", "--bun", "playwright", "install", "chromium"];
    if (!cli) {
      log.warn(
        "playwright package not resolvable; falling back to `bunx --bun playwright` (avoid Python playwright on PATH)",
      );
    }

    const proc = Bun.spawn(cmd, {
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
        // Avoid debug noise leaking into the TUI
        DEBUG: "",
        PWDEBUG: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      drainQuiet(proc.stdout as ReadableStream<Uint8Array>, onProgress),
      drainQuiet(proc.stderr as ReadableStream<Uint8Array>, onProgress),
    ]);

    const code = await proc.exited;
    if (code !== 0) {
      const combined = `${stdout}\n${stderr}`.trim();
      log.error(`Playwright Chromium install failed (exit ${code}): ${combined.slice(0, 2000)}`);
      let msg = `Failed to install Playwright Chromium (exit ${code})`;
      if (/ModuleNotFoundError|No module named ['"]playwright['"]/i.test(combined)) {
        msg +=
          ". A Python `playwright` CLI was likely invoked instead of the npm package — install npm playwright (`bun add playwright`) and retry, or set crawl.playwright: never.";
      }
      throw new Error(msg);
    }
    await Bun.write(marker, new Date().toISOString());
    log.info("Playwright Chromium install complete");
    onProgress?.("Chromium ready");
  }
  return browsersPath;
}

export async function getBrowser(dataDir: string, onProgress?: BrowserProgress): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      try {
        await ensurePlaywrightBrowser(dataDir, onProgress);
        let chromium: {
          launch: (opts: { headless: boolean }) => Promise<Browser>;
        };
        try {
          const mod = await import("playwright");
          chromium = mod.chromium;
          if (!chromium || typeof chromium.launch !== "function") {
            throw new Error("playwright stub (no chromium.launch)");
          }
        } catch (err) {
          const detail = formatError(err);
          log.error(`playwright import failed: ${detail}`);
          throw new Error(
            `Playwright is not available (${detail}). Install it (\`bun add playwright\` / \`npm i -g playwright\`) or set crawl.playwright: never. Browser fallback works best when running via \`bun run localdoc\`.`,
            { cause: err },
          );
        }
        onProgress?.("Launching headless Chromium…");
        return await chromium.launch({ headless: true });
      } catch (err) {
        browserPromise = null;
        throw err;
      }
    })();
  }
  return browserPromise;
}

export async function fetchWithPlaywright(
  url: string,
  config: LocaldocConfig,
  dataDir: string,
  onProgress?: BrowserProgress,
  scopeRoot?: string,
): Promise<{ ok: boolean; url: string; body: string; error?: string }> {
  try {
    if (scopeRoot && !isUnderRoot(url, scopeRoot)) {
      return {
        ok: false,
        url,
        body: "",
        error: `URL out of crawl scope: ${url}`,
      };
    }
    const browser = await getBrowser(dataDir, onProgress);
    const contextOpts: {
      userAgent: string;
      extraHTTPHeaders: Record<string, string>;
      ignoreHTTPSErrors?: boolean;
      proxy?: { server: string; bypass?: string };
    } = {
      userAgent: "localdoc/0.1 (+https://github.com/Marius-brt/Local-Doc; docs indexer)",
      extraHTTPHeaders: {
        ...config.http.headers,
        ...config.crawl.headers,
      },
    };
    if (!config.http.proxy.reject_unauthorized) {
      contextOpts.ignoreHTTPSErrors = true;
    }
    if (config.http.proxy.url) {
      contextOpts.proxy = {
        server: config.http.proxy.url,
        ...(config.http.proxy.ignore.length > 0
          ? { bypass: config.http.proxy.ignore.join(",") }
          : {}),
      };
    }
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
    try {
      if (scopeRoot) {
        // Block document navigations that leave the crawl root (redirect SSRF).
        await page.route("**/*", async (route) => {
          if (route.request().resourceType() === "document") {
            if (!isUnderRoot(route.request().url(), scopeRoot)) {
              await route.abort("blockedbyclient");
              return;
            }
          }
          await route.continue();
        });
      }
      onProgress?.(`Fetching via browser: ${url}`);
      const res = await page.goto(url, {
        waitUntil: "networkidle",
        timeout: config.crawl.timeout_ms,
      });
      const finalUrl = page.url();
      if (scopeRoot && !isUnderRoot(finalUrl, scopeRoot)) {
        return {
          ok: false,
          url: finalUrl,
          body: "",
          error: `final URL left crawl scope: ${finalUrl}`,
        };
      }
      const body = await page.content();
      return {
        ok: Boolean(res?.ok()),
        url: finalUrl,
        body,
        error: res?.ok() ? undefined : `HTTP ${res?.status() ?? 0}`,
      };
    } finally {
      await context.close();
    }
  } catch (err) {
    return {
      ok: false,
      url,
      body: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch {
      // launch may have failed; still clear singleton
    }
    browserPromise = null;
  }
}
