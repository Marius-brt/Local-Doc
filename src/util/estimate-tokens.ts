/** Rough token estimate for budgeted context packs (~4 chars/token). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
