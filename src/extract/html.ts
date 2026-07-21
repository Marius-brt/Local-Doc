import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { normalizeTitle, sanitizeMarkdown } from "./sanitize.ts";

/**
 * Bump when extract/sanitize rules change so `localdoc update` rechunks
 * pages whose remote content hash is unchanged.
 */
export const EXTRACTOR_VERSION = 2;

const BOILERPLATE_SELECTORS = [
  "header",
  "footer",
  "nav",
  "aside",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  ".sidebar",
  ".side-bar",
  ".toc",
  ".table-of-contents",
  ".navbar",
  ".nav-bar",
  ".footer",
  ".header",
  ".breadcrumb",
  ".breadcrumbs",
  "#sidebar",
  "#toc",
  "#navbar",
  "#footer",
  "#header",
  ".mintlify-header",
  ".gitbook-root header",
];

/** In-content chrome that must be removed even inside article/main. */
const CHROME_SELECTORS = [
  ".headerlink",
  "a.headerlink",
  "a.anchor",
  ".hash-link",
  "a.hash-link",
  ".anchor-link",
  "[aria-hidden='true']",
  "button",
  "[role='tablist']",
  ".pagination-nav",
  ".pagination",
  ".theme-doc-footer",
  ".theme-edit-this-page",
  ".md-source",
  ".toc-copy",
  ".copy-button",
  ".copybtn",
  "[data-testid='page-toc']",
  ".on-this-page",
];

export interface ExtractedPage {
  title: string;
  markdown: string;
  adapter: string;
  canonical?: string | null;
  lang?: string | null;
  version?: string | null;
}

function createTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  turndown.addRule("dropScripts", {
    filter: ["script", "style", "noscript", "svg", "iframe"],
    replacement: () => "",
  });

  // Sphinx / Prism highlight wrappers → fenced code with language
  turndown.addRule("highlightBlock", {
    filter(node) {
      if (node.nodeName !== "DIV") return false;
      const cls = (node as Element).getAttribute("class") ?? "";
      return /(?:^|\s)highlight-(\w+)/.test(cls) || /(?:^|\s)language-(\w+)/.test(cls);
    },
    replacement(_content, node) {
      const el = node as Element;
      const cls = el.getAttribute("class") ?? "";
      const m = cls.match(/(?:highlight-|language-)(\w+)/);
      const lang = m?.[1] ?? "";
      const pre = el.querySelector("pre");
      const code = (pre?.textContent ?? el.textContent ?? "").replace(/\n$/, "");
      if (!code.trim()) return "";
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    },
  });

  // HTML tables → GFM pipe tables (enables TableChunker)
  turndown.addRule("gfmTable", {
    filter: "table",
    replacement(_content, node) {
      const table = node as HTMLTableElement;
      const rows = Array.from(table.querySelectorAll("tr"));
      if (rows.length === 0) return "";
      const matrix: string[][] = rows.map((tr) =>
        Array.from(tr.querySelectorAll("th,td")).map((cell) =>
          (cell.textContent ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim(),
        ),
      );
      const width = Math.max(...matrix.map((r) => r.length), 0);
      if (width === 0) return "";
      const padded = matrix.map((r) => {
        const row = [...r];
        while (row.length < width) row.push("");
        return row;
      });
      const header = padded[0]!;
      const sep = header.map(() => "---");
      const body = padded.slice(1);
      const lines = [
        `| ${header.join(" | ")} |`,
        `| ${sep.join(" | ")} |`,
        ...body.map((r) => `| ${r.join(" | ")} |`),
      ];
      return `\n\n${lines.join("\n")}\n\n`;
    },
  });

  return turndown;
}

const turndown = createTurndown();

function stripSelectors(document: Document, selectors: string[]): void {
  for (const sel of selectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      el.remove();
    }
  }
}

export function stripBoilerplate(document: Document): void {
  stripSelectors(document, BOILERPLATE_SELECTORS);
}

export function stripChrome(document: Document): void {
  stripSelectors(document, CHROME_SELECTORS);
}

function pickMain(document: Document): Element {
  const candidates = [
    "article",
    "main",
    "[role='main']",
    ".markdown",
    ".md-content",
    ".doc-content",
    ".documentation",
    ".theme-doc-markdown",
    "#content",
    ".content",
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && (el.textContent?.trim().length ?? 0) > 80) return el;
  }
  return document.body ?? document.documentElement;
}

function titleFromRoot(root: Element, document: Document): string {
  const h1 = root.querySelector("h1");
  if (h1?.textContent?.trim()) return normalizeTitle(h1.textContent);
  const docH1 = document.querySelector("h1");
  if (docH1?.textContent?.trim()) return normalizeTitle(docH1.textContent);
  const t = document.querySelector("title");
  if (t?.textContent?.trim()) return normalizeTitle(t.textContent);
  return "Untitled";
}

function readCanonical(document: Document): string | null {
  const link = document.querySelector('link[rel="canonical"]');
  const href = link?.getAttribute("href")?.trim();
  return href || null;
}

function readLang(document: Document): string | null {
  const html = document.documentElement;
  const lang = html?.getAttribute("lang")?.trim();
  return lang || null;
}

/** Convert a DOM subtree to sanitized markdown (shared by generic + adapters). */
export function markdownFromElement(
  root: Element,
  document: Document,
): {
  title: string;
  markdown: string;
  canonical: string | null;
  lang: string | null;
} {
  // Clone via outer parse of innerHTML so we can strip chrome inside the root only
  const { document: fragDoc } = parseHTML(`<div id="localdoc-root">${root.innerHTML}</div>`);
  const fragRoot = fragDoc.querySelector("#localdoc-root") ?? fragDoc.body;
  stripChrome(fragDoc as unknown as Document);
  const title = titleFromRoot(root, document);
  const raw = turndown.turndown(fragRoot?.innerHTML || "").trim();
  const markdown = sanitizeMarkdown(raw);
  return {
    title,
    markdown,
    canonical: readCanonical(document),
    lang: readLang(document),
  };
}

export function htmlToMarkdown(html: string): ExtractedPage {
  return extractWithRootSelector(html, null, "generic");
}

/**
 * Shared extract path: strip site chrome → pick root → Turndown → sanitize.
 * When `selectors` is provided, first matching node becomes the root (adapters).
 */
export function extractWithRootSelector(
  html: string,
  selectors: string[] | null,
  adapter: string,
): ExtractedPage {
  const { document } = parseHTML(html);
  stripBoilerplate(document as unknown as Document);

  let root: Element | null = null;
  if (selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && (el.textContent?.trim().length ?? 0) > 80) {
        root = el;
        break;
      }
    }
  }
  root ??= pickMain(document as unknown as Document);

  const { title, markdown, canonical, lang } = markdownFromElement(
    root,
    document as unknown as Document,
  );
  return { title, markdown, adapter, canonical, lang };
}

/**
 * Thin-page / chrome-only gate.
 * Short authentic API pages with code/headings pass; long nav soup fails.
 */
export function isBoilerplateOnly(markdown: string): boolean {
  const cleaned = markdown.replace(/\s+/g, " ").trim();
  if (!cleaned) return true;

  const lines = markdown.split("\n").filter((l) => l.trim());
  const headingCount = lines.filter((l) => /^#{1,6}\s+\S/.test(l)).length;
  const hasCode = /```[\s\S]*?```/.test(markdown) || /^( {4}|\t)\S/m.test(markdown);
  const hasTable = /^\|.+\|$/m.test(markdown);
  // Structured content is never treated as boilerplate, even when short.
  if (headingCount >= 1 || hasCode || hasTable) return false;

  if (cleaned.length < 40) return true;

  // Link-heavy chrome: many bare words that look like menu items
  const words = cleaned.split(/\s+/).length;
  const linkish = (markdown.match(/\[[^\]]+]/g) ?? []).length;
  if (words > 0 && linkish / Math.max(words / 4, 1) > 0.6 && headingCount === 0) {
    return true;
  }

  // Very short with no structure
  return cleaned.length < 80;
}
