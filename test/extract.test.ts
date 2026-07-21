import { describe, expect, test } from "bun:test";
import { extractPage } from "../src/crawl/adapters/index.ts";
import {
  dedupeVersionedUrls,
  filterUrlsForRoot,
  isSameOrigin,
  isSkippableContentType,
  isUnderRoot,
  normalizeUrl,
  stripVersionPath,
  urlInFetchScope,
} from "../src/crawl/urls.ts";
import { EXTRACTOR_VERSION, htmlToMarkdown, isBoilerplateOnly } from "../src/extract/html.ts";
import { normalizeTitle, sanitizeMarkdown } from "../src/extract/sanitize.ts";

describe("sanitize", () => {
  test("strips Direct link anchors from markdown", () => {
    const md = sanitizeMarkdown(
      `## Examples[](#examples-8 "Direct link to Examples")\n\nHello[](#x "Direct link to Hello") world`,
    );
    expect(md).not.toContain("Direct link");
    expect(md).not.toContain("[](#");
    expect(md).toContain("## Examples");
    expect(md).toContain("Hello world");
  });

  test("normalizeTitle strips brand suffixes", () => {
    expect(normalizeTitle("Python API | RAGFlow")).toBe("Python API");
    expect(normalizeTitle("Install — Docs")).toBe("Install");
  });
});

describe("html extract", () => {
  test("EXTRACTOR_VERSION is set", () => {
    expect(EXTRACTOR_VERSION).toBeGreaterThanOrEqual(2);
  });

  test("removes hash-link noise and keeps heading text", () => {
    const html = `
      <html><body>
        <article>
          <h1>Auth<a class="hash-link" href="#auth" title="Direct link to Auth"></a></h1>
          <p>Use the <code>login</code> method.</p>
          <pre><code class="language-python">print(1)</code></pre>
        </article>
      </body></html>`;
    const page = htmlToMarkdown(html);
    expect(page.markdown).not.toContain("Direct link");
    expect(page.markdown).toContain("Auth");
    expect(page.title).toBe("Auth");
  });

  test("converts HTML tables to GFM pipes", () => {
    const html = `
      <html><body><article>
        <h1>Opts</h1>
        <table>
          <tr><th>Name</th><th>Type</th></tr>
          <tr><td>timeout</td><td>number</td></tr>
        </table>
      </article></body></html>`;
    const page = htmlToMarkdown(html);
    expect(page.markdown).toContain("| Name | Type |");
    expect(page.markdown).toContain("| timeout | number |");
  });

  test("docusaurus adapter uses shared strip path", () => {
    const html = `
      <html><body class="docusaurus">
        <nav>MenuItem Home</nav>
        <div class="theme-doc-markdown">
          <h1>Guide<a class="hash-link" href="#guide" aria-hidden="true">#</a></h1>
          <p>Real content about APIs.</p>
        </div>
        <nav class="pagination-nav"><a>Prev</a><a>Next</a></nav>
      </body></html>`;
    const page = extractPage(html, "https://example.com/docs");
    expect(page.adapter).toBe("docusaurus");
    expect(page.markdown).toContain("Real content");
    expect(page.markdown).not.toMatch(/Prev\s*Next/);
  });

  test("isBoilerplateOnly allows short code pages", () => {
    expect(isBoilerplateOnly("```python\nprint(1)\n```")).toBe(false);
    expect(isBoilerplateOnly("ok")).toBe(true);
  });
});

describe("url helpers", () => {
  test("normalizeUrl strips hash index and trailing slash", () => {
    expect(normalizeUrl("https://Ex.com/docs/foo/#bar")).toBe("https://ex.com/docs/foo");
    expect(normalizeUrl("https://ex.com/docs/index.html")).toBe("https://ex.com/docs");
  });

  test("filterUrlsForRoot scopes to path", () => {
    const urls = ["https://ex.com/docs/a", "https://ex.com/blog/b", "https://ex.com/docs/v1/c"];
    expect(filterUrlsForRoot(urls, "https://ex.com/docs")).toEqual([
      "https://ex.com/docs/a",
      "https://ex.com/docs/v1/c",
    ]);
  });

  test("isSameOrigin / isUnderRoot / urlInFetchScope", () => {
    expect(isSameOrigin("https://ex.com/sitemap.xml", "https://ex.com/docs")).toBe(true);
    expect(isSameOrigin("http://169.254.169.254/", "https://ex.com/docs")).toBe(false);
    expect(isUnderRoot("https://ex.com/docs/a", "https://ex.com/docs")).toBe(true);
    expect(isUnderRoot("https://ex.com/blog", "https://ex.com/docs")).toBe(false);
    expect(
      urlInFetchScope("https://ex.com/sitemap.xml", {
        mode: "same-origin",
        root: "https://ex.com/docs",
      }),
    ).toBe(true);
    expect(
      urlInFetchScope("https://evil.com/x", { mode: "same-origin", root: "https://ex.com/docs" }),
    ).toBe(false);
    expect(
      urlInFetchScope("https://ex.com/blog", { mode: "under-root", root: "https://ex.com/docs" }),
    ).toBe(false);
  });

  test("dedupeVersionedUrls prefers unversioned", () => {
    const out = dedupeVersionedUrls([
      "https://ex.com/docs/foo",
      "https://ex.com/docs/v0.26.4/foo",
      "https://ex.com/docs/v0.25.0/foo",
      "https://ex.com/docs/other",
    ]);
    expect(out).toContain("https://ex.com/docs/foo");
    expect(out).toContain("https://ex.com/docs/other");
    expect(out.some((u) => u.includes("v0."))).toBe(false);
  });

  test("stripVersionPath", () => {
    expect(stripVersionPath("/docs/v0.26.4/python_api").unversionedPath).toBe("/docs/python_api");
    expect(stripVersionPath("/docs/v0.26.4/python_api").version).toBe("v0.26.4");
  });

  test("isSkippableContentType", () => {
    expect(isSkippableContentType("application/json")).toBe(true);
    expect(isSkippableContentType("text/html; charset=utf-8")).toBe(false);
  });
});
