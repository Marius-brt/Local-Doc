/**
 * Shared markdown/title cleaners used at ingest (indexed corpus) and pack time.
 * Bump EXTRACTOR_VERSION in html.ts when these rules change materially.
 */

/** Strip doc-generator noise from headings (empty anchors, permalinks, link wrappers). */
export function cleanHeading(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .replace(/\[\]\([^)]*\)/g, "")
    .replace(/\[¶\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/\s*\{#[^}]+\}/g, "")
    .replace(/\s*Direct link to\s+.+$/i, "")
    .replace(/\s*Permalink(?:\s+to\s+.+)?$/i, "")
    .replace(/¶+/g, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

/** Compact markdown body: remove anchors, comments, excess blank lines. */
export function cleanChunkText(text: string): string {
  let s = text;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/\[\]\([^)]*\)/g, "");
  s = s.replace(/\[¶\]\([^)]*\)/g, "");
  s = s.replace(/¶+/g, "");
  // Keep link label; drop URL (document URI is stored separately)
  s = s.replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1");
  s = s.replace(/<\/?(?:span|div|br|hr)[^>]*>/gi, "\n");
  s = s.replace(/[ \t]+$/gm, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[^\S\n]{2,}/g, " ");
  return s.trim();
}

/** Clean ATX heading lines inside a full markdown document. */
export function sanitizeMarkdown(markdown: string): string {
  const cleaned = cleanChunkText(markdown);
  return cleaned
    .split("\n")
    .map((line) => {
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      if (!m) return line;
      const heading = cleanHeading(m[2]!);
      return heading ? `${m[1]} ${heading}` : line;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Normalize page titles: strip site brand suffixes and link noise. */
export function normalizeTitle(raw: string | null | undefined): string {
  let s = cleanHeading(raw) ?? "";
  if (!s) return "Untitled";
  // "Install | Product Docs" / "Install — Docs" → Install
  s = s.replace(/\s*[|–—]\s*[^|–—]{1,40}$/u, "").trim();
  s = s.replace(/\s+[—–-]\s*(Docs?|Documentation|Manual|Guide)$/i, "").trim();
  return s || "Untitled";
}
