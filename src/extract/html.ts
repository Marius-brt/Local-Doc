import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

turndown.addRule("dropScripts", {
  filter: ["script", "style", "noscript", "svg", "iframe"],
  replacement: () => "",
});

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

export interface ExtractedPage {
  title: string;
  markdown: string;
  adapter: string;
}

function stripBoilerplate(document: Document): void {
  for (const sel of BOILERPLATE_SELECTORS) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      el.remove();
    }
  }
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

function pageTitle(document: Document): string {
  const h1 = document.querySelector("h1");
  if (h1?.textContent?.trim()) return h1.textContent.trim();
  const t = document.querySelector("title");
  if (t?.textContent?.trim()) return t.textContent.trim();
  return "Untitled";
}

export function htmlToMarkdown(html: string): ExtractedPage {
  const { document } = parseHTML(html);
  stripBoilerplate(document as unknown as Document);
  const main = pickMain(document as unknown as Document);
  const title = pageTitle(document as unknown as Document);
  const markdown = turndown.turndown(main.innerHTML || "").trim();
  return { title, markdown, adapter: "generic" };
}

export function isBoilerplateOnly(markdown: string): boolean {
  const cleaned = markdown.replace(/\s+/g, " ").trim();
  return cleaned.length < 40;
}
