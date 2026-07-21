import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LocaldocConfig } from "../config/schema.ts";

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
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
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
    const proc = Bun.spawn(["bunx", "playwright", "install", "chromium"], {
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

    await Promise.all([
      drainQuiet(proc.stdout as ReadableStream<Uint8Array>, onProgress),
      drainQuiet(proc.stderr as ReadableStream<Uint8Array>, onProgress),
    ]);

    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`Failed to install Playwright Chromium (exit ${code})`);
    }
    await Bun.write(marker, new Date().toISOString());
    onProgress?.("Chromium ready");
  }
  return browsersPath;
}

export async function getBrowser(dataDir: string, onProgress?: BrowserProgress): Promise<Browser> {
  if (!browserPromise) {
    await ensurePlaywrightBrowser(dataDir, onProgress);
    browserPromise = (async () => {
      let chromium: {
        launch: (opts: { headless: boolean }) => Promise<Browser>;
      };
      try {
        const mod = await import("playwright");
        chromium = mod.chromium;
        if (!chromium || typeof chromium.launch !== "function") {
          throw new Error("playwright stub");
        }
      } catch {
        throw new Error(
          "Playwright is not available. Install it (`bun add playwright` / `npm i -g playwright`) or set crawl.playwright: never. Browser fallback works best when running via `bun run localdoc`.",
        );
      }
      onProgress?.("Launching headless Chromium…");
      return chromium.launch({ headless: true });
    })();
  }
  return browserPromise;
}

export async function fetchWithPlaywright(
  url: string,
  config: LocaldocConfig,
  dataDir: string,
  onProgress?: BrowserProgress,
): Promise<{ ok: boolean; url: string; body: string; error?: string }> {
  try {
    const browser = await getBrowser(dataDir, onProgress);
    const page = await browser.newPage({
      userAgent: "localdoc/0.1 (+https://github.com/localdoc/localdoc; docs indexer)",
      extraHTTPHeaders: {
        ...config.http.headers,
        ...config.crawl.headers,
      },
    });
    try {
      onProgress?.(`Fetching via browser: ${url}`);
      const res = await page.goto(url, {
        waitUntil: "networkidle",
        timeout: config.crawl.timeout_ms,
      });
      const body = await page.content();
      return {
        ok: Boolean(res?.ok()),
        url: page.url(),
        body,
        error: res?.ok() ? undefined : `HTTP ${res?.status() ?? 0}`,
      };
    } finally {
      await page.close();
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
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}
