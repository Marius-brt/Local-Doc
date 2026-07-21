import type { SearchHit } from "../search/hybrid.ts";
import { estimateTokens } from "../util/estimate-tokens.ts";

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

export function buildContextPack(
  query: string,
  hits: SearchHit[],
  budgetTokens: number,
): ContextPack {
  const sections: ContextPack["sections"] = [];
  let totalTokens = 0;
  let estimatedRawTokens = 0;

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const tokens = estimateTokens(hit.text);
    estimatedRawTokens += tokens;
    if (totalTokens + tokens > budgetTokens && sections.length > 0) {
      break;
    }
    // Truncate last section to fit budget
    let text = hit.text;
    let used = tokens;
    if (totalTokens + tokens > budgetTokens) {
      const remaining = Math.max(0, budgetTokens - totalTokens);
      const chars = remaining * 4;
      text = `${hit.text.slice(0, chars)}\n…`;
      used = estimateTokens(text);
    }
    sections.push({
      rank: i + 1,
      title: hit.title,
      uri: hit.uri,
      heading: hit.heading,
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

export function formatPackMarkdown(pack: ContextPack): string {
  const lines: string[] = [];
  lines.push(`# localdoc context pack`);
  lines.push(``);
  lines.push(`Query: ${pack.query}`);
  lines.push(
    `Tokens: ~${pack.totalTokens} (raw ~${pack.estimatedRawTokens}, saved ~${pack.savedPercent}%)`,
  );
  lines.push(``);
  for (const s of pack.sections) {
    const label = s.heading || s.title || "section";
    lines.push(`## [${s.rank}] ${label}`);
    lines.push(`Source: ${s.uri}`);
    lines.push(``);
    lines.push(s.text);
    lines.push(``);
  }
  if (pack.sections.length === 0) {
    lines.push("_No matching documentation found. Run `localdoc list` and `localdoc add`._");
  }
  return lines.join("\n");
}
