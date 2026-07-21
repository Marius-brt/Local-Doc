import { type ExtractedPage, extractWithRootSelector, htmlToMarkdown } from "../../extract/html.ts";

export interface SiteAdapter {
  name: string;
  detect(html: string, url: string): boolean;
  extract(html: string, url: string): ExtractedPage;
}

function extractWithSelector(html: string, selectors: string[], name: string): ExtractedPage {
  return extractWithRootSelector(html, selectors, name);
}

export const mintlifyAdapter: SiteAdapter = {
  name: "mintlify",
  detect(html, url) {
    return /mintlify/i.test(html) || /mintlify/i.test(url);
  },
  extract(html) {
    return extractWithSelector(
      html,
      ["#content-area", ".mdx-content", "article", "main"],
      "mintlify",
    );
  },
};

export const gitbookAdapter: SiteAdapter = {
  name: "gitbook",
  detect(html) {
    return /gitbook/i.test(html);
  },
  extract(html) {
    return extractWithSelector(
      html,
      [".page-body", ".markdown-body", "article", "main"],
      "gitbook",
    );
  },
};

export const docusaurusAdapter: SiteAdapter = {
  name: "docusaurus",
  detect(html) {
    return (
      /docusaurus/i.test(html) || html.includes("theme-doc-markdown") || html.includes("infima")
    );
  },
  extract(html) {
    return extractWithSelector(html, [".theme-doc-markdown", "article", "main"], "docusaurus");
  },
};

export const readmeAdapter: SiteAdapter = {
  name: "readme",
  detect(html) {
    return html.includes("readme.io") || html.includes("rm-Markdown");
  },
  extract(html) {
    return extractWithSelector(html, [".rm-Markdown", "article", "main"], "readme");
  },
};

export const sphinxAdapter: SiteAdapter = {
  name: "sphinx",
  detect(html) {
    return /sphinx/i.test(html) || html.includes("wy-nav-content") || html.includes("rst-content");
  },
  extract(html) {
    return extractWithSelector(
      html,
      [".rst-content", "[role='main']", "article", "main"],
      "sphinx",
    );
  },
};

export const genericAdapter: SiteAdapter = {
  name: "generic",
  detect() {
    return true;
  },
  extract(html) {
    return htmlToMarkdown(html);
  },
};

export const ADAPTERS: SiteAdapter[] = [
  mintlifyAdapter,
  gitbookAdapter,
  docusaurusAdapter,
  readmeAdapter,
  sphinxAdapter,
  genericAdapter,
];

export function extractPage(html: string, url: string): ExtractedPage {
  for (const adapter of ADAPTERS) {
    if (adapter.detect(html, url)) {
      return adapter.extract(html, url);
    }
  }
  return genericAdapter.extract(html, url);
}
