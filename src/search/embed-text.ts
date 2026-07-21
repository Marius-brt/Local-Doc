import { cleanChunkText, cleanHeading } from "../extract/sanitize.ts";

/** Build the string embedded for a chunk (title + section path + body). */
export function embedTextForChunk(input: {
  title?: string | null;
  sectionPath?: string | null;
  text: string;
}): string {
  const title = cleanHeading(input.title)?.trim() || "";
  const section = cleanHeading(input.sectionPath)?.trim() || "";
  const body = cleanChunkText(input.text);
  if (title && section) return `${title}\n${section}\n\n${body}`;
  if (title) return `${title}\n\n${body}`;
  if (section) return `${section}\n\n${body}`;
  return body;
}

/** Document text passed to rerankers (title / heading / body). */
export function rerankDocumentText(hit: {
  title?: string | null;
  heading?: string | null;
  text: string;
}): string {
  const parts: string[] = [];
  if (hit.title?.trim()) parts.push(hit.title.trim());
  if (hit.heading?.trim()) parts.push(hit.heading.trim());
  parts.push(hit.text);
  return parts.join("\n");
}
