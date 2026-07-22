import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import pLimit from "p-limit";
import { chunkDocument } from "../chunk/index.ts";
import type { LocaldocConfig } from "../config/schema.ts";
import { extractPage } from "../crawl/adapters/index.ts";
import { type DiscoveryStrategy, discoverUrls } from "../crawl/discover.ts";
import { buildFetchInit, fetchText } from "../crawl/fetch.ts";
import {
  detectUrlVersion,
  isSkippableContentType,
  isUnderRoot,
  normalizeUrl,
} from "../crawl/urls.ts";
import { nowIso } from "../db/client.ts";
import {
  deleteChunksForDocument,
  documentExtractorVersion,
  getDocumentByUri,
  insertChunks,
  insertEmbedding,
  pruneDocumentsNotIn,
  upsertDocument,
} from "../db/documents.ts";
import { type SourceKind, upsertSource } from "../db/sources.ts";
import { ensureVectorIndex, getVectorDims } from "../db/vector-index.ts";
import { type Embedder, tryCreateEmbedder } from "../embed/index.ts";
import { EXTRACTOR_VERSION, isBoilerplateOnly } from "../extract/html.ts";
import {
  isOpenApiDocument,
  looksLikeOpenApiUrl,
  openApiToMarkdown,
  parseOpenApiText,
} from "../extract/openapi.ts";
import { normalizeTitle, sanitizeMarkdown } from "../extract/sanitize.ts";
import { embedTextForChunk } from "../search/embed-text.ts";
import { pathToUri, resolveFolderPath } from "../util/file-uri.ts";
import { sha256, shortId } from "../util/hash.ts";
import { log } from "../util/log.ts";
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
  strategy?: DiscoveryStrategy | "openapi";
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

function logIngestSummary(report: IngestReport): void {
  const errPreview =
    report.errors.length > 0
      ? ` errors=[${report.errors
          .slice(0, 5)
          .map((e) => `${e.uri}: ${e.error}`)
          .join("; ")}${report.errors.length > 5 ? "; …" : ""}]`
      : "";
  log.info(
    `ingest done kind=${report.kind} root=${report.rootUri}` +
      (report.strategy ? ` strategy=${report.strategy}` : "") +
      ` ok=${report.pagesOk} skipped=${report.pagesSkipped} failed=${report.pagesFailed}` +
      ` started=${report.startedAt} finished=${report.finishedAt}${errPreview}`,
  );
}

/** Probe embedder dims and ensure vector schema once per ingest job. */
async function prepareVectorIndex(
  db: Client,
  dataDir: string,
  embedder: Embedder | null,
  signal?: AbortSignal,
): Promise<void> {
  if (!embedder) return;
  throwIfAborted(signal);
  const existing = await getVectorDims(db);
  if (existing != null && existing > 0 && embedder.dims > 0 && embedder.dims === existing) {
    await ensureVectorIndex(db, existing, { dataDir });
    return;
  }
  // Probe live dims when unknown or possibly changed.
  const [probe] = await embedder.embed(["dimension probe"], signal);
  const dims = probe?.length ?? embedder.dims;
  if (dims > 0) {
    log.info(`preparing vector index (${dims}-d) before parallel ingest`);
    await ensureVectorIndex(db, dims, { dataDir });
  }
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
  meta?: Record<string, unknown>;
  onProgress?: (p: IngestProgress) => void;
}): Promise<"ok" | "skipped"> {
  const { db, config, dataDir, sourceId, recreate, embedder } = opts;
  let uri = opts.uri;
  try {
    if (/^https?:\/\//i.test(uri)) uri = normalizeUrl(uri);
  } catch {
    // keep
  }
  const title = normalizeTitle(opts.title);
  const markdown = sanitizeMarkdown(opts.markdown);
  const contentHash = sha256(markdown);
  const existing = await getDocumentByUri(db, sourceId, uri);
  const existingVersion = existing ? documentExtractorVersion(existing) : null;
  if (
    !recreate &&
    existing?.content_hash === contentHash &&
    existing.status === "ok" &&
    existingVersion === EXTRACTOR_VERSION
  ) {
    return "skipped";
  }

  const extractedDir = join(dataDir, "extracted", sourceId);
  await mkdir(extractedDir, { recursive: true });
  const extractedPath = join(extractedDir, `${shortId(uri)}.md`);
  await writeFile(extractedPath, markdown, "utf8");

  const version = detectUrlVersion(uri);
  const meta: Record<string, unknown> = {
    extractor_version: EXTRACTOR_VERSION,
    ...(opts.meta ?? {}),
  };
  if (version && meta.version == null) meta.version = version;

  const doc = await upsertDocument(db, {
    sourceId,
    uri,
    title,
    contentHash,
    extractedPath,
    status: "ok",
    error: null,
    meta,
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
    title: title ?? null,
    startOffset: c.startOffset,
    endOffset: c.endOffset,
    contentHash: c.contentHash,
    meta: {
      kind: c.kind,
      ...(c.language ? { language: c.language } : {}),
    },
  }));
  await insertChunks(db, chunkRows);

  if (embedder && chunkRows.length > 0) {
    opts.onProgress?.({
      phase: "embed",
      total: chunkRows.length,
      message: `Embedding ${chunkRows.length} chunks · ${uri}`,
    });
    log.info(`embed start uri=${uri} chunks=${chunkRows.length} model=${embedder.modelId}`);
    const t0 = Date.now();
    const vectors = await embedder.embed(
      chunkRows.map((c) =>
        embedTextForChunk({ title: c.title, sectionPath: c.sectionPath, text: c.text }),
      ),
    );
    log.info(
      `embed done uri=${uri} chunks=${chunkRows.length} ms=${Date.now() - t0} model=${embedder.modelId}`,
    );
    for (let i = 0; i < chunkRows.length; i++) {
      await insertEmbedding(db, chunkRows[i]!.id, embedder.modelId, vectors[i]!);
    }
  }
  return "ok";
}

async function markDocumentError(
  db: Client,
  sourceId: string,
  uri: string,
  message: string,
): Promise<void> {
  let normalized = uri;
  try {
    if (/^https?:\/\//i.test(uri)) normalized = normalizeUrl(uri);
  } catch {
    // keep
  }
  const existing = await getDocumentByUri(db, sourceId, normalized);
  if (existing) {
    await deleteChunksForDocument(db, existing.id);
  }
  await upsertDocument(db, {
    sourceId,
    uri: normalized,
    status: "error",
    error: message,
    meta: { extractor_version: EXTRACTOR_VERSION },
  });
}

type PlaywrightFallbackReason =
  | "mode=always"
  | "http_failed"
  | "empty_body"
  | "cloudflare_challenge"
  | "boilerplate_only"
  | "extract_failed";

function playwrightFallbackReason(
  mode: string,
  ok: boolean,
  html: string,
  finalUrl: string,
): PlaywrightFallbackReason | null {
  if (mode === "always") return "mode=always";
  if (mode !== "auto") return null;
  if (!ok) return "http_failed";
  if (!html.trim()) return "empty_body";
  if (html.includes("cf-browser-verification") || html.includes("Just a moment...")) {
    return "cloudflare_challenge";
  }
  try {
    const page = extractPage(html, finalUrl);
    if (isBoilerplateOnly(page.markdown)) return "boilerplate_only";
  } catch {
    return "extract_failed";
  }
  return null;
}

async function fetchPageContent(
  url: string,
  rootUrl: string,
  config: LocaldocConfig,
  dataDir: string,
  onBrowserProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<{
  ok: boolean;
  finalUrl: string;
  html: string;
  contentType: string;
  usedPlaywright: boolean;
  error?: string;
}> {
  throwIfAborted(signal);
  const mode = config.crawl.playwright;
  const browserProgress = onBrowserProgress
    ? (message: string) => onBrowserProgress(message)
    : undefined;
  const pageScope = { mode: "under-root" as const, root: rootUrl };

  if (mode === "always") {
    const reason: PlaywrightFallbackReason = "mode=always";
    const msg = `Playwright fallback (${reason}): ${url}`;
    log.warn(msg);
    console.error(`[localdoc] ${msg}`);
    browserProgress?.(msg);
    const { fetchWithPlaywright } = await import("../playwright/browser.ts");
    const pw = await fetchWithPlaywright(url, config, dataDir, browserProgress, rootUrl);
    if (pw.ok) log.info(`Playwright ok: ${url}`);
    else log.warn(`Playwright failed: ${url} — ${pw.error ?? "unknown"}`);
    return {
      ok: pw.ok,
      finalUrl: pw.url,
      html: pw.body,
      contentType: "text/html",
      usedPlaywright: true,
      error: pw.error,
    };
  }

  const res = await fetchText(url, config, signal, pageScope);
  let html = res.body;
  let ok = res.ok;
  let finalUrl = res.url;
  let contentType = res.contentType ?? "";
  let usedPlaywright = false;
  let error = res.error;

  if (ok && isSkippableContentType(contentType)) {
    return {
      ok: false,
      finalUrl,
      html: "",
      contentType,
      usedPlaywright: false,
      error: `unsupported content-type: ${contentType}`,
    };
  }

  const reason = playwrightFallbackReason(mode, ok, html, finalUrl);
  const needsBrowser = reason != null;

  if (needsBrowser && reason) {
    throwIfAborted(signal);
    const msg =
      reason === "http_failed"
        ? `Playwright fallback (${reason}): ${url} — ${error ?? "fetch failed"}`
        : `Playwright fallback (${reason}): ${url}`;
    log.warn(msg);
    console.error(`[localdoc] ${msg}`);
    browserProgress?.(msg);
    const { fetchWithPlaywright } = await import("../playwright/browser.ts");
    const pw = await fetchWithPlaywright(url, config, dataDir, browserProgress, rootUrl);
    if (pw.ok && pw.body) {
      html = pw.body;
      ok = true;
      finalUrl = pw.url;
      contentType = "text/html";
      usedPlaywright = true;
      error = undefined;
      log.info(`Playwright ok after ${reason}: ${url}`);
    } else {
      log.warn(`Playwright failed after ${reason}: ${url} — ${pw.error ?? "unknown"}`);
      if (!ok) {
        error = pw.error ?? error;
      }
    }
  }

  if (ok) {
    try {
      const normalized = normalizeUrl(finalUrl);
      if (!isUnderRoot(normalized, rootUrl)) {
        return {
          ok: false,
          finalUrl: normalized,
          html: "",
          contentType,
          usedPlaywright,
          error: `final URL left crawl scope: ${normalized}`,
        };
      }
      finalUrl = normalized;
    } catch {
      return {
        ok: false,
        finalUrl,
        html: "",
        contentType,
        usedPlaywright,
        error: `invalid final URL: ${finalUrl}`,
      };
    }
  }

  return { ok, finalUrl, html, contentType, usedPlaywright, error };
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
  const webStrategy =
    options.strategy && options.strategy !== "openapi" ? options.strategy : undefined;
  const discovery = await discoverUrls(rootUrl, config, webStrategy, options.signal);
  throwIfAborted(options.signal);
  log.info(`discover strategy=${discovery.strategy} urls=${discovery.urls.length} root=${rootUrl}`);
  await upsertSource(db, {
    kind: "web",
    rootUri: rootUrl,
    strategy: discovery.strategy,
    status: "indexing",
  });

  await prepareVectorIndex(db, dataDir, embedder, options.signal);

  const limit = pLimit(config.crawl.concurrency);
  let pagesOk = 0;
  let pagesFailed = 0;
  let pagesSkipped = 0;
  const errors: Array<{ uri: string; error: string }> = [];
  const keepUris = new Set<string>();

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
              const res = await fetchText(url, config, options.signal, {
                mode: "under-root",
                root: rootUrl,
              });
              if (!res.ok) throw new Error(res.error ?? "fetch failed");
              const uri = normalizeUrl(res.url);
              if (!isUnderRoot(uri, rootUrl)) {
                throw new Error(`final URL left crawl scope: ${uri}`);
              }
              keepUris.add(uri);
              const result = await indexMarkdownDoc({
                db,
                config,
                dataDir,
                sourceId: source.id,
                uri,
                title: url.split("/").pop() ?? url,
                markdown: res.body,
                recreate: Boolean(options.recreate),
                embedder,
                meta: { adapter: "llms-txt" },
                onProgress: progress,
              });
              if (result === "skipped") pagesSkipped++;
              else pagesOk++;
              return;
            }

            const fetched = await fetchPageContent(
              url,
              rootUrl,
              config,
              dataDir,
              (message) => progress({ phase: "browser", message }),
              options.signal,
            );
            if (!fetched.ok || !fetched.html) {
              throw new Error(fetched.error ?? "empty response");
            }
            if (isSkippableContentType(fetched.contentType)) {
              throw new Error(`unsupported content-type: ${fetched.contentType}`);
            }
            const extracted = extractPage(fetched.html, fetched.finalUrl);
            if (isBoilerplateOnly(extracted.markdown)) {
              throw new Error("boilerplate-only content");
            }
            const uri = normalizeUrl(fetched.finalUrl);
            if (!isUnderRoot(uri, rootUrl)) {
              throw new Error(`final URL left crawl scope: ${uri}`);
            }
            keepUris.add(uri);
            const result = await indexMarkdownDoc({
              db,
              config,
              dataDir,
              sourceId: source.id,
              uri,
              title: extracted.title,
              markdown: extracted.markdown,
              recreate: Boolean(options.recreate),
              embedder,
              meta: {
                adapter: extracted.adapter,
                canonical: extracted.canonical ?? undefined,
                lang: extracted.lang ?? undefined,
              },
              onProgress: progress,
            });
            if (result === "skipped") pagesSkipped++;
            else pagesOk++;
          } catch (err) {
            if (isAbortError(err)) throw err;
            pagesFailed++;
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ uri: url, error: message });
            log.warn(`ingest page failed uri=${url} error=${message}`);
            await markDocumentError(db, source.id, url, message);
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

  if (keepUris.size > 0) {
    await pruneDocumentsNotIn(db, source.id, keepUris);
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
  logIngestSummary(report);
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
  await prepareVectorIndex(db, dataDir, embedder, options.signal);

  let pagesOk = 0;
  let pagesFailed = 0;
  let pagesSkipped = 0;
  const errors: Array<{ uri: string; error: string }> = [];

  const keepUris = new Set<string>();
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
          let title = file.path.split("/").pop() ?? file.path;
          let adapter = "filesystem";
          if (/\.html?$/i.test(file.path)) {
            const extracted = extractPage(file.content, file.uri);
            content = extracted.markdown;
            title = extracted.title || title;
            adapter = extracted.adapter;
          }
          keepUris.add(file.uri);
          const result = await indexMarkdownDoc({
            db,
            config,
            dataDir,
            sourceId: source.id,
            uri: file.uri,
            title,
            markdown: content,
            recreate: Boolean(options.recreate),
            embedder,
            meta: { adapter },
            onProgress: progress,
          });
          if (result === "skipped") pagesSkipped++;
          else pagesOk++;
        } catch (err) {
          if (isAbortError(err)) throw err;
          pagesFailed++;
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ uri: file.uri, error: message });
          log.warn(`ingest page failed uri=${file.uri} error=${message}`);
          await markDocumentError(db, source.id, file.uri, message);
        }
      }),
    ),
  );

  if (keepUris.size > 0) {
    await pruneDocumentsNotIn(db, source.id, keepUris);
  }

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
  logIngestSummary(report);
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

  await prepareVectorIndex(db, dataDir, embedder, options.signal);

  let pagesOk = 0;
  let pagesFailed = 0;
  let pagesSkipped = 0;
  const errors: Array<{ uri: string; error: string }> = [];
  const keepUris = new Set<string>();
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
          let content = file.content;
          let title = file.path.split("/").pop() ?? file.path;
          let adapter = "github";
          if (/\.html?$/i.test(file.path)) {
            const extracted = extractPage(file.content, file.uri);
            content = extracted.markdown;
            title = extracted.title || title;
            adapter = extracted.adapter;
          }
          keepUris.add(file.uri);
          const result = await indexMarkdownDoc({
            db,
            config,
            dataDir,
            sourceId: source.id,
            uri: file.uri,
            title,
            markdown: content,
            recreate: Boolean(options.recreate),
            embedder,
            meta: { adapter },
            onProgress: progress,
          });
          if (result === "skipped") pagesSkipped++;
          else pagesOk++;
        } catch (err) {
          if (isAbortError(err)) throw err;
          pagesFailed++;
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ uri: file.uri, error: message });
          log.warn(`ingest page failed uri=${file.uri} error=${message}`);
          await markDocumentError(db, source.id, file.uri, message);
        }
      }),
    ),
  );

  if (keepUris.size > 0) {
    await pruneDocumentsNotIn(db, source.id, keepUris);
  }

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
  logIngestSummary(report);
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
    if (options.strategy === "openapi" || looksLikeOpenApiUrl(target)) {
      return ingestOpenApi(db, config, dataDir, target, options);
    }
    return ingestWeb(db, config, dataDir, target, options);
  }
  // folder (path or file:// URI from stored root_uri on update)
  const abs = resolveFolderPath(target);
  const st = await stat(abs);
  if (!st.isDirectory()) {
    throw new Error(`Not a directory, URL, GitHub repo, or OpenAPI URL: ${target}`);
  }
  return ingestFolder(db, config, dataDir, abs, options);
}

/**
 * Fetch an OpenAPI / Swagger spec URL, convert to markdown, and index as one document.
 */
export async function ingestOpenApi(
  db: Client,
  config: LocaldocConfig,
  dataDir: string,
  specUrl: string,
  options: IngestOptions = {},
): Promise<IngestReport> {
  const startedAt = nowIso();
  const progress = options.onProgress ?? (() => {});
  const embedder = await tryCreateEmbedder(config, dataDir);
  const rootUrl = normalizeUrl(specUrl);

  const source = await upsertSource(db, {
    kind: "web",
    rootUri: rootUrl,
    title: rootUrl,
    strategy: "openapi",
    status: "indexing",
  });

  progress({ phase: "fetch", message: `Fetching OpenAPI spec ${rootUrl}` });
  log.info(`openapi fetch ${rootUrl}`);

  let pagesOk = 0;
  let pagesFailed = 0;
  let pagesSkipped = 0;
  const errors: Array<{ uri: string; error: string }> = [];
  const keepUris = new Set<string>();

  try {
    throwIfAborted(options.signal);
    const init = buildFetchInit(config, {
      url: rootUrl,
      signal: options.signal,
      headers: {
        Accept:
          "application/json, application/yaml, text/yaml, application/x-yaml, text/plain, */*;q=0.8",
      },
    });
    const res = await fetch(rootUrl, init);
    const body = await res.text();
    const finalUrl = normalizeUrl(res.url || rootUrl);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!body.trim()) {
      throw new Error("empty OpenAPI response");
    }

    progress({ phase: "parse", message: "Parsing OpenAPI document…" });
    let parsed: unknown;
    try {
      parsed = parseOpenApiText(body);
    } catch (err) {
      throw new Error(
        `Failed to parse OpenAPI JSON/YAML: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!isOpenApiDocument(parsed)) {
      throw new Error(
        "URL did not return an OpenAPI/Swagger document (missing openapi/swagger/paths+info)",
      );
    }

    const { title, markdown, version } = openApiToMarkdown(parsed);
    progress({ phase: "index", message: `Indexing ${title}${version ? ` ${version}` : ""}` });
    await prepareVectorIndex(db, dataDir, embedder, options.signal);

    keepUris.add(finalUrl);
    const result = await indexMarkdownDoc({
      db,
      config,
      dataDir,
      sourceId: source.id,
      uri: finalUrl,
      title,
      markdown,
      recreate: Boolean(options.recreate),
      embedder,
      meta: {
        adapter: "openapi",
        openapi_version: parsed.openapi ?? parsed.swagger ?? null,
        api_version: version,
      },
      onProgress: progress,
    });
    if (result === "skipped") pagesSkipped++;
    else pagesOk++;
  } catch (err) {
    if (isAbortError(err)) {
      await upsertSource(db, {
        kind: "web",
        rootUri: rootUrl,
        strategy: "openapi",
        status: "error",
      });
      throw err;
    }
    pagesFailed++;
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ uri: rootUrl, error: message });
    log.warn(`openapi ingest failed uri=${rootUrl} error=${message}`);
    await markDocumentError(db, source.id, rootUrl, message);
  }

  if (keepUris.size > 0) {
    await pruneDocumentsNotIn(db, source.id, keepUris);
  }

  await upsertSource(db, {
    kind: "web",
    rootUri: rootUrl,
    strategy: "openapi",
    status: pagesFailed > 0 && pagesOk === 0 ? "error" : "ready",
  });

  const report: IngestReport = {
    sourceId: source.id,
    rootUri: rootUrl,
    kind: "web",
    strategy: "openapi",
    pagesOk,
    pagesFailed,
    pagesSkipped,
    errors,
    startedAt,
    finishedAt: nowIso(),
  };
  logIngestSummary(report);
  return report;
}
