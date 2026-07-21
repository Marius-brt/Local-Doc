import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import pLimit from "p-limit";
import { chunkDocument } from "../chunk/index.ts";
import type { LocaldocConfig } from "../config/schema.ts";
import { extractPage } from "../crawl/adapters/index.ts";
import { type DiscoveryStrategy, discoverUrls } from "../crawl/discover.ts";
import { fetchText } from "../crawl/fetch.ts";
import { nowIso } from "../db/client.ts";
import {
  deleteChunksForDocument,
  getDocumentByUri,
  insertChunks,
  insertEmbedding,
  upsertDocument,
} from "../db/documents.ts";
import { type SourceKind, upsertSource } from "../db/sources.ts";
import { ensureVectorIndex } from "../db/vector-index.ts";
import { type Embedder, tryCreateEmbedder } from "../embed/index.ts";
import { isBoilerplateOnly } from "../extract/html.ts";
import { pathToUri, resolveFolderPath } from "../util/file-uri.ts";
import { sha256, shortId } from "../util/hash.ts";
import { collectFolderFiles } from "./folder.ts";
import { collectGithubFiles, collectGithubViaApi, isGithubInput } from "./github.ts";

export interface IngestProgress {
  phase: string;
  current?: number;
  total?: number;
  message?: string;
}

export interface IngestOptions {
  recreate?: boolean;
  strategy?: DiscoveryStrategy;
  onProgress?: (p: IngestProgress) => void;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Cancelled");
    err.name = "AbortError";
    throw err;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "Cancelled");
}

export interface IngestReport {
  sourceId: string;
  rootUri: string;
  kind: SourceKind;
  strategy?: string;
  pagesOk: number;
  pagesFailed: number;
  pagesSkipped: number;
  errors: Array<{ uri: string; error: string }>;
  startedAt: string;
  finishedAt: string;
}

async function indexMarkdownDoc(opts: {
  db: Client;
  config: LocaldocConfig;
  dataDir: string;
  sourceId: string;
  uri: string;
  title: string;
  markdown: string;
  recreate: boolean;
  embedder: Embedder | null;
}): Promise<"ok" | "skipped"> {
  const { db, config, dataDir, sourceId, uri, title, markdown, recreate, embedder } = opts;
  const contentHash = sha256(markdown);
  const existing = await getDocumentByUri(db, sourceId, uri);
  if (!recreate && existing?.content_hash === contentHash && existing.status === "ok") {
    return "skipped";
  }

  const extractedDir = join(dataDir, "extracted", sourceId);
  await mkdir(extractedDir, { recursive: true });
  const extractedPath = join(extractedDir, `${shortId(uri)}.md`);
  await writeFile(extractedPath, markdown, "utf8");

  const doc = await upsertDocument(db, {
    sourceId,
    uri,
    title,
    contentHash,
    extractedPath,
    status: "ok",
    error: null,
  });

  await deleteChunksForDocument(db, doc.id);
  const chunks = await chunkDocument(markdown, uri, config);
  const chunkRows = chunks.map((c, i) => ({
    id: shortId(`${doc.id}:${i}:${c.contentHash}`),
    documentId: doc.id,
    sourceId,
    chunkIndex: i,
    text: c.text,
    heading: c.heading,
    sectionPath: c.sectionPath,
    startOffset: c.startOffset,
    endOffset: c.endOffset,
    contentHash: c.contentHash,
    meta: { kind: c.kind },
  }));
  await insertChunks(db, chunkRows);

  if (embedder) {
    const vectors = await embedder.embed(chunkRows.map((c) => c.text));
    const dims = vectors[0]?.length ?? embedder.dims;
    if (dims > 0) {
      await ensureVectorIndex(db, dims);
    }
    for (let i = 0; i < chunkRows.length; i++) {
      await insertEmbedding(db, chunkRows[i]!.id, embedder.modelId, vectors[i]!);
    }
  }
  return "ok";
}

async function fetchPageContent(
  url: string,
  config: LocaldocConfig,
  dataDir: string,
  onBrowserProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<{
  ok: boolean;
  finalUrl: string;
  html: string;
  usedPlaywright: boolean;
  error?: string;
}> {
  throwIfAborted(signal);
  const mode = config.crawl.playwright;
  const browserProgress = onBrowserProgress
    ? (message: string) => onBrowserProgress(message)
    : undefined;

  if (mode === "always") {
    const { fetchWithPlaywright } = await import("../playwright/browser.ts");
    const pw = await fetchWithPlaywright(url, config, dataDir, browserProgress);
    return {
      ok: pw.ok,
      finalUrl: pw.url,
      html: pw.body,
      usedPlaywright: true,
      error: pw.error,
    };
  }

  const res = await fetchText(url, config, signal);
  let html = res.body;
  let ok = res.ok;
  let finalUrl = res.url;
  let usedPlaywright = false;
  let error = res.error;

  const needsBrowser =
    mode === "auto" &&
    (!ok ||
      !html.trim() ||
      html.includes("cf-browser-verification") ||
      html.includes("Just a moment...") ||
      (() => {
        try {
          const page = extractPage(html, finalUrl);
          return isBoilerplateOnly(page.markdown);
        } catch {
          return true;
        }
      })());

  if (needsBrowser) {
    throwIfAborted(signal);
    const { fetchWithPlaywright } = await import("../playwright/browser.ts");
    const pw = await fetchWithPlaywright(url, config, dataDir, browserProgress);
    if (pw.ok && pw.body) {
      html = pw.body;
      ok = true;
      finalUrl = pw.url;
      usedPlaywright = true;
      error = undefined;
    } else if (!ok) {
      error = pw.error ?? error;
    }
  }

  return { ok, finalUrl, html, usedPlaywright, error };
}

export async function ingestWeb(
  db: Client,
  config: LocaldocConfig,
  dataDir: string,
  rootUrl: string,
  options: IngestOptions = {},
): Promise<IngestReport> {
  const startedAt = nowIso();
  const progress = options.onProgress ?? (() => {});
  const embedder = await tryCreateEmbedder(config, dataDir);

  const source = await upsertSource(db, {
    kind: "web",
    rootUri: rootUrl,
    title: rootUrl,
    status: "indexing",
  });

  progress({ phase: "discover", message: "Discovering URLs…" });
  const discovery = await discoverUrls(rootUrl, config, options.strategy, options.signal);
  throwIfAborted(options.signal);
  await upsertSource(db, {
    kind: "web",
    rootUri: rootUrl,
    strategy: discovery.strategy,
    status: "indexing",
  });

  const limit = pLimit(config.crawl.concurrency);
  let pagesOk = 0;
  let pagesFailed = 0;
  let pagesSkipped = 0;
  const errors: Array<{ uri: string; error: string }> = [];

  progress({
    phase: "fetch",
    total: discovery.urls.length,
    message: `Fetching ${discovery.urls.length} pages via ${discovery.strategy}`,
  });

  try {
    await Promise.all(
      discovery.urls.map((url, idx) =>
        limit(async () => {
          throwIfAborted(options.signal);
          progress({
            phase: "fetch",
            current: idx + 1,
            total: discovery.urls.length,
            message: url,
          });
          try {
            // Special-case llms-full.txt as markdown
            if (url.endsWith("llms-full.txt") || url.endsWith("llms.txt")) {
              const res = await fetchText(url, config, options.signal);
              if (!res.ok) throw new Error(res.error ?? "fetch failed");
              const result = await indexMarkdownDoc({
                db,
                config,
                dataDir,
                sourceId: source.id,
                uri: res.url,
                title: url.split("/").pop() ?? url,
                markdown: res.body,
                recreate: Boolean(options.recreate),
                embedder,
              });
              if (result === "skipped") pagesSkipped++;
              else pagesOk++;
              return;
            }

            const fetched = await fetchPageContent(
              url,
              config,
              dataDir,
              (message) => progress({ phase: "browser", message }),
              options.signal,
            );
            if (!fetched.ok || !fetched.html) {
              throw new Error(fetched.error ?? "empty response");
            }
            const extracted = extractPage(fetched.html, fetched.finalUrl);
            if (isBoilerplateOnly(extracted.markdown)) {
              throw new Error("boilerplate-only content");
            }
            const result = await indexMarkdownDoc({
              db,
              config,
              dataDir,
              sourceId: source.id,
              uri: fetched.finalUrl,
              title: extracted.title,
              markdown: extracted.markdown,
              recreate: Boolean(options.recreate),
              embedder,
            });
            if (result === "skipped") pagesSkipped++;
            else pagesOk++;
          } catch (err) {
            if (isAbortError(err)) throw err;
            pagesFailed++;
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ uri: url, error: message });
            await upsertDocument(db, {
              sourceId: source.id,
              uri: url,
              status: "error",
              error: message,
            });
          }
        }),
      ),
    );
  } catch (err) {
    if (isAbortError(err)) {
      await upsertSource(db, {
        kind: "web",
        rootUri: rootUrl,
        strategy: discovery.strategy,
        status: "error",
      });
      throw err;
    }
    throw err;
  }

  await upsertSource(db, {
    kind: "web",
    rootUri: rootUrl,
    strategy: discovery.strategy,
    status: "ready",
  });

  const finishedAt = nowIso();
  const report: IngestReport = {
    sourceId: source.id,
    rootUri: rootUrl,
    kind: "web",
    strategy: discovery.strategy,
    pagesOk,
    pagesFailed,
    pagesSkipped,
    errors,
    startedAt,
    finishedAt,
  };
  await writeReport(dataDir, report);
  return report;
}

export async function ingestFolder(
  db: Client,
  config: LocaldocConfig,
  dataDir: string,
  folderPath: string,
  options: IngestOptions = {},
): Promise<IngestReport> {
  const startedAt = nowIso();
  const progress = options.onProgress ?? (() => {});
  const abs = resolveFolderPath(folderPath);
  const embedder = await tryCreateEmbedder(config, dataDir);
  const rootUri = pathToUri(abs);

  const source = await upsertSource(db, {
    kind: "folder",
    rootUri,
    title: abs,
    strategy: "filesystem",
    status: "indexing",
  });

  progress({ phase: "scan", message: `Scanning ${abs}` });
  const files = await collectFolderFiles(abs);
  let pagesOk = 0;
  let pagesFailed = 0;
  let pagesSkipped = 0;
  const errors: Array<{ uri: string; error: string }> = [];

  const limit = pLimit(config.crawl.concurrency);
  await Promise.all(
    files.map((file, idx) =>
      limit(async () => {
        throwIfAborted(options.signal);
        progress({
          phase: "index",
          current: idx + 1,
          total: files.length,
          message: file.path,
        });
        try {
          let content = file.content;
          if (/\.html?$/i.test(file.path)) {
            content = extractPage(file.content, file.uri).markdown;
          }
          const result = await indexMarkdownDoc({
            db,
            config,
            dataDir,
            sourceId: source.id,
            uri: file.uri,
            title: file.path.split("/").pop() ?? file.path,
            markdown: content,
            recreate: Boolean(options.recreate),
            embedder,
          });
          if (result === "skipped") pagesSkipped++;
          else pagesOk++;
        } catch (err) {
          if (isAbortError(err)) throw err;
          pagesFailed++;
          errors.push({
            uri: file.uri,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    ),
  );

  await upsertSource(db, {
    kind: "folder",
    rootUri,
    status: "ready",
  });

  const report: IngestReport = {
    sourceId: source.id,
    rootUri,
    kind: "folder",
    strategy: "filesystem",
    pagesOk,
    pagesFailed,
    pagesSkipped,
    errors,
    startedAt,
    finishedAt: nowIso(),
  };
  await writeReport(dataDir, report);
  return report;
}

export async function ingestGithub(
  db: Client,
  config: LocaldocConfig,
  dataDir: string,
  input: string,
  options: IngestOptions = {},
): Promise<IngestReport> {
  const startedAt = nowIso();
  const progress = options.onProgress ?? (() => {});
  const embedder = await tryCreateEmbedder(config, dataDir);

  progress({ phase: "clone", message: "Fetching GitHub repository…" });
  let collected: Awaited<ReturnType<typeof collectGithubFiles>>;
  try {
    throwIfAborted(options.signal);
    collected = await collectGithubFiles(input);
  } catch (err) {
    if (isAbortError(err)) throw err;
    collected = await collectGithubViaApi(input, config, options.signal);
  }

  throwIfAborted(options.signal);

  const source = await upsertSource(db, {
    kind: "github",
    rootUri: collected.rootUri,
    title: collected.title,
    strategy: "github",
    status: "indexing",
  });

  let pagesOk = 0;
  let pagesFailed = 0;
  let pagesSkipped = 0;
  const errors: Array<{ uri: string; error: string }> = [];
  const limit = pLimit(config.crawl.concurrency);

  await Promise.all(
    collected.files.map((file, idx) =>
      limit(async () => {
        throwIfAborted(options.signal);
        progress({
          phase: "index",
          current: idx + 1,
          total: collected.files.length,
          message: file.path,
        });
        try {
          const result = await indexMarkdownDoc({
            db,
            config,
            dataDir,
            sourceId: source.id,
            uri: file.uri,
            title: file.path.split("/").pop() ?? file.path,
            markdown: file.content,
            recreate: Boolean(options.recreate),
            embedder,
          });
          if (result === "skipped") pagesSkipped++;
          else pagesOk++;
        } catch (err) {
          if (isAbortError(err)) throw err;
          pagesFailed++;
          errors.push({
            uri: file.uri,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    ),
  );

  await upsertSource(db, {
    kind: "github",
    rootUri: collected.rootUri,
    status: "ready",
  });

  const report: IngestReport = {
    sourceId: source.id,
    rootUri: collected.rootUri,
    kind: "github",
    strategy: "github",
    pagesOk,
    pagesFailed,
    pagesSkipped,
    errors,
    startedAt,
    finishedAt: nowIso(),
  };
  await writeReport(dataDir, report);
  return report;
}

export async function ingestTarget(
  db: Client,
  config: LocaldocConfig,
  dataDir: string,
  target: string,
  options: IngestOptions = {},
): Promise<IngestReport> {
  if (isGithubInput(target)) {
    return ingestGithub(db, config, dataDir, target, options);
  }
  if (/^https?:\/\//i.test(target)) {
    return ingestWeb(db, config, dataDir, target, options);
  }
  // folder (path or file:// URI from stored root_uri on update)
  const abs = resolveFolderPath(target);
  const st = await stat(abs);
  if (!st.isDirectory()) {
    throw new Error(`Not a directory, URL, or GitHub repo: ${target}`);
  }
  return ingestFolder(db, config, dataDir, abs, options);
}

async function writeReport(dataDir: string, report: IngestReport): Promise<void> {
  const path = join(dataDir, "last-ingest-report.json");
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
}
