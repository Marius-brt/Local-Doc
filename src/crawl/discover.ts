import { parseHTML } from "linkedom";
import robotsParser from "robots-parser";
import type { LocaldocConfig } from "../config/schema.ts";
import { fetchOptional, fetchText } from "./fetch.ts";

export type DiscoveryStrategy = "llms-full.txt" | "llms.txt" | "sitemap.xml" | "nav-crawl";

export interface DiscoveryResult {
  strategy: DiscoveryStrategy;
  urls: string[];
}

function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function resolveUrl(base: string, href: string): string | null {
  try {
    const u = new URL(href, base);
    u.hash = "";
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function parseLlmsTxt(text: string, base: string): string[] {
  const urls: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const mdLink = trimmed.match(/\((https?:\/\/[^)]+)\)/);
    if (mdLink?.[1]) {
      urls.push(mdLink[1]);
      continue;
    }
    const bare = trimmed.match(/https?:\/\/\S+/);
    if (bare?.[0]) {
      urls.push(bare[0].replace(/[.,;]+$/, ""));
      continue;
    }
    if (trimmed.startsWith("/")) {
      const resolved = resolveUrl(base, trimmed);
      if (resolved) urls.push(resolved);
    }
  }
  return [...new Set(urls)];
}

async function discoverLlmsFull(root: string, config: LocaldocConfig): Promise<string[] | null> {
  const origin = originOf(root);
  for (const path of ["/llms-full.txt", "/docs/llms-full.txt"]) {
    const body = await fetchOptional(origin + path, config);
    if (!body) continue;
    // llms-full is often one giant markdown doc — treat as single page
    if (body.length > 500 && !body.includes("http")) {
      return [origin + path];
    }
    const urls = parseLlmsTxt(body, origin);
    if (urls.length > 0) return urls.slice(0, config.crawl.max_pages);
    return [origin + path];
  }
  return null;
}

async function discoverLlms(root: string, config: LocaldocConfig): Promise<string[] | null> {
  const origin = originOf(root);
  for (const path of ["/llms.txt", "/docs/llms.txt"]) {
    const body = await fetchOptional(origin + path, config);
    if (!body) continue;
    const urls = parseLlmsTxt(body, origin);
    if (urls.length > 0) return urls.slice(0, config.crawl.max_pages);
  }
  return null;
}

async function parseSitemapUrls(xml: string, config: LocaldocConfig, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const urls: string[] = [];
  const locRegex = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  const locs: string[] = [];
  while ((match = locRegex.exec(xml))) {
    const loc = match[1]?.trim();
    if (loc) locs.push(loc);
  }
  for (const loc of locs) {
    if (urls.length >= config.crawl.max_pages) break;
    if (loc.endsWith(".xml") || loc.includes("sitemap")) {
      const child = await fetchOptional(loc, config);
      if (child) {
        const nested = await parseSitemapUrls(child, config, depth + 1);
        for (const u of nested) {
          if (urls.length >= config.crawl.max_pages) break;
          urls.push(u);
        }
      }
    } else {
      urls.push(loc);
    }
  }
  return [...new Set(urls)];
}

async function discoverSitemap(root: string, config: LocaldocConfig): Promise<string[] | null> {
  const origin = originOf(root);
  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/docs/sitemap.xml`,
    new URL("/sitemap.xml", root).toString(),
  ];
  for (const candidate of [...new Set(candidates)]) {
    const body = await fetchOptional(candidate, config);
    if (!body?.includes("<loc>")) continue;
    const urls = await parseSitemapUrls(body, config);
    if (urls.length > 0) return urls.slice(0, config.crawl.max_pages);
  }
  return null;
}

function extractNavLinks(html: string, base: string): string[] {
  const { document } = parseHTML(html);
  const urls: string[] = [];
  const containers = [
    "nav",
    "aside",
    "[role='navigation']",
    ".sidebar",
    ".menu",
    ".toc",
    "#sidebar",
  ];
  const roots: Element[] = [];
  for (const sel of containers) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      roots.push(el);
    }
  }
  if (roots.length === 0 && document.body) roots.push(document.body);

  for (const root of roots) {
    for (const a of Array.from(root.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href");
      if (!href) continue;
      if (href.startsWith("#") || href.startsWith("mailto:")) continue;
      const resolved = resolveUrl(base, href);
      if (!resolved) continue;
      try {
        const u = new URL(resolved);
        const baseHost = new URL(base).host;
        if (u.host !== baseHost) continue;
        // Prefer doc-like paths
        urls.push(resolved);
      } catch {
        // skip
      }
    }
  }
  return [...new Set(urls)];
}

async function discoverNavCrawl(root: string, config: LocaldocConfig): Promise<string[]> {
  const seen = new Set<string>();
  const queue: string[] = [root];
  const results: string[] = [];

  while (queue.length > 0 && results.length < config.crawl.max_pages) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await fetchText(url, config);
    if (!res.ok) continue;
    results.push(res.url);
    const links = extractNavLinks(res.body, res.url);
    for (const link of links) {
      if (!seen.has(link) && results.length + queue.length < config.crawl.max_pages * 2) {
        queue.push(link);
      }
    }
  }
  return results.slice(0, config.crawl.max_pages);
}

export async function loadRobots(
  root: string,
  config: LocaldocConfig,
): Promise<{ isAllowed: (url: string) => boolean } | null> {
  if (!config.crawl.respect_robots) return null;
  const origin = originOf(root);
  const body = await fetchOptional(`${origin}/robots.txt`, config);
  if (!body) return null;
  const robots = robotsParser(`${origin}/robots.txt`, body);
  return {
    isAllowed: (url: string) => robots.isAllowed(url, "localdoc") !== false,
  };
}

export async function discoverUrls(
  root: string,
  config: LocaldocConfig,
  forcedStrategy?: DiscoveryStrategy,
): Promise<DiscoveryResult> {
  const strategies: DiscoveryStrategy[] = forcedStrategy
    ? [forcedStrategy]
    : ["llms-full.txt", "llms.txt", "sitemap.xml", "nav-crawl"];

  for (const strategy of strategies) {
    let urls: string[] | null = null;
    if (strategy === "llms-full.txt") urls = await discoverLlmsFull(root, config);
    else if (strategy === "llms.txt") urls = await discoverLlms(root, config);
    else if (strategy === "sitemap.xml") urls = await discoverSitemap(root, config);
    else if (strategy === "nav-crawl") urls = await discoverNavCrawl(root, config);

    if (urls && urls.length > 0) {
      const robots = await loadRobots(root, config);
      const filtered = robots ? urls.filter((u) => robots.isAllowed(u)) : urls;
      if (filtered.length > 0) {
        return { strategy, urls: filtered.slice(0, config.crawl.max_pages) };
      }
    }
  }

  return { strategy: "nav-crawl", urls: [root] };
}
