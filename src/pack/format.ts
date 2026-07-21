import { cleanChunkText, cleanHeading } from "../extract/sanitize.ts";
import type { SearchHit } from "../search/hybrid.ts";
import { estimateTokens } from "../util/estimate-tokens.ts";

export { cleanChunkText, cleanHeading } from "../extract/sanitize.ts";

export interface ContextPack {
  query: string;
  sections: Array<{
    rank: number;
    title: string | null;
    uri: string;
    heading: string | null;
    text: string;
    score: number;
    tokens: number;
  }>;
  totalTokens: number;
  estimatedRawTokens: number;
  savedPercent: number;
}

/** Soft cap so one huge hit cannot consume the entire budget alone. */
const MAX_SECTION_BUDGET_FRACTION = 0.45;

/** Truncate on paragraph / unicode sentence boundaries when possible. */
export function truncateAtBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const para = slice.lastIndexOf("\n\n");
  if (para >= Math.floor(maxChars * 0.4)) {
    return `${slice.slice(0, para).trimEnd()}\n…`;
  }
  const sentenceRe = /[.!?。！？…]\s/g;
  let lastSentence = -1;
  let m: RegExpExecArray | null;
  while ((m = sentenceRe.exec(slice))) {
    lastSentence = m.index + m[0].length;
  }
  if (lastSentence >= Math.floor(maxChars * 0.4)) {
    return `${slice.slice(0, lastSentence).trimEnd()}\n…`;
  }
  const space = slice.lastIndexOf(" ");
  if (space >= Math.floor(maxChars * 0.4)) {
    return `${slice.slice(0, space).trimEnd()}\n…`;
  }
  return `${slice.trimEnd()}\n…`;
}

function normalizeForDedup(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when `candidate` adds little/no new content vs an already-kept excerpt. */
export function isNearDuplicate(kept: string, candidate: string): boolean {
  const a = normalizeForDedup(kept);
  const b = normalizeForDedup(candidate);
  if (!a || !b) return true;
  if (a === b) return true;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 48) return false;

  // Containment / truncated twin
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.82) return true;

  // Shared long prefix (same example with tiny suffix drift)
  const n = Math.min(240, shorter.length);
  if (shorter.slice(0, n) === longer.slice(0, n) && shorter.length / longer.length >= 0.75) {
    return true;
  }
  return false;
}

function stripRedundantLead(text: string, label: string | null): string {
  if (!label) return text;
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (i >= lines.length) return text;
  const first = lines[i]!.trim();
  if (!/^#{1,6}\s+/.test(first)) return text;
  const headingText = first.replace(/^#{1,6}\s+/, "").trim();
  const normLabel = normalizeForDedup(label);
  const normHead = normalizeForDedup(cleanHeading(headingText) ?? headingText);
  if (!normHead) return text;
  const redundant =
    normHead === normLabel ||
    normHead.startsWith(`${normLabel} `) ||
    normLabel.startsWith(normHead);
  if (!redundant) return text;
  const rest = lines
    .slice(i + 1)
    .join("\n")
    .replace(/^\n+/, "");
  return rest.trim() ? rest : text;
}

/** True when a heading is leftover source syntax, not a useful section title. */
function isWeakCodeHeading(heading: string | null | undefined): boolean {
  if (!heading) return true;
  const h = heading.trim();
  if (!h) return true;
  // describe("…", () => {  /  import { … }  /  trailing block
  if (/[{;]\s*$/.test(h)) return true;
  if (/^(import|export|from|const|let|var|require)\b/.test(h)) return true;
  if (/^(describe|context|suite|test|it|specify)\s*\(/.test(h)) return true;
  return false;
}

function sectionLabel(hit: Pick<SearchHit, "heading" | "title" | "sectionPath" | "uri">): string {
  const heading = cleanHeading(hit.heading);
  if (heading && !isWeakCodeHeading(heading)) return heading;
  const title = cleanHeading(hit.title);
  if (title) return title;
  const path = cleanHeading(hit.sectionPath);
  if (path && !isWeakCodeHeading(path)) return path;
  // Last resort: file basename from URI
  try {
    const base = decodeURIComponent(new URL(hit.uri).pathname).split("/").pop();
    if (base) return base;
  } catch {
    const base = hit.uri.split("/").pop();
    if (base) return base;
  }
  return "Excerpt";
}

export function buildContextPack(
  query: string,
  hits: SearchHit[],
  budgetTokens: number,
): ContextPack {
  const sections: ContextPack["sections"] = [];
  let totalTokens = 0;
  let estimatedRawTokens = 0;
  const perSectionCap = Math.max(64, Math.floor(budgetTokens * MAX_SECTION_BUDGET_FRACTION));
  const keptTexts: string[] = [];

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    estimatedRawTokens += estimateTokens(hit.text);

    const label = sectionLabel(hit);
    let text = cleanChunkText(hit.text);
    text = stripRedundantLead(text, label);
    if (!text) continue;

    // Drop near-duplicates of already packed excerpts (saves agent tokens).
    if (keptTexts.some((k) => isNearDuplicate(k, text))) {
      continue;
    }

    const rawTokens = estimateTokens(text);
    const remaining = budgetTokens - totalTokens;
    if (remaining <= 0 && sections.length > 0) break;

    const allowed = Math.min(remaining > 0 ? remaining : budgetTokens, perSectionCap);
    let used = rawTokens;

    if (rawTokens > allowed) {
      const chars = allowed * 4;
      text = truncateAtBoundary(text, chars);
      used = estimateTokens(text);
      if (used > allowed) {
        text = truncateAtBoundary(text, Math.max(16, (allowed - 1) * 4));
        used = estimateTokens(text);
      }
    }

    if (totalTokens + used > budgetTokens && sections.length > 0) {
      break;
    }

    keptTexts.push(text);
    sections.push({
      rank: sections.length + 1,
      title: cleanHeading(hit.title),
      uri: hit.uri,
      heading: label,
      text,
      score: hit.score,
      tokens: used,
    });
    totalTokens += used;
  }

  const savedPercent =
    estimatedRawTokens > 0
      ? Math.round((1 - totalTokens / Math.max(estimatedRawTokens, totalTokens)) * 100)
      : 0;

  return {
    query,
    sections,
    totalTokens,
    estimatedRawTokens: Math.max(estimatedRawTokens, totalTokens),
    savedPercent,
  };
}

/**
 * Compact, model-oriented markdown.
 * Omits decorative chrome (token stats, "Source:" labels) that waste agent context.
 */
export function formatPackMarkdown(pack: ContextPack): string {
  if (pack.sections.length === 0) {
    return "No matching documentation found. Run `localdoc list` and `localdoc add`.\n";
  }

  const parts: string[] = [];
  parts.push(`# ${pack.query}`);
  parts.push("");

  for (const s of pack.sections) {
    const label = s.heading || s.title || "Excerpt";
    parts.push(`## ${s.rank}. ${label}`);
    parts.push(s.uri);
    parts.push("");
    parts.push(s.text);
    parts.push("");
  }

  return `${parts.join("\n").trimEnd()}\n`;
}
