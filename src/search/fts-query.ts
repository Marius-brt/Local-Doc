/**
 * Multilingual FTS5 query builder.
 * Language-agnostic: unicode punctuation strip, compact multilingual stop list,
 * AND/NEAR for content terms. No English stemming.
 */

/** Compact closed-class words across major Latin-script languages (+ a few others). */
const MULTILINGUAL_STOPWORDS = new Set(
  [
    // English
    "a",
    "an",
    "the",
    "and",
    "or",
    "but",
    "if",
    "then",
    "else",
    "when",
    "at",
    "by",
    "for",
    "with",
    "about",
    "against",
    "between",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "to",
    "from",
    "up",
    "down",
    "in",
    "out",
    "on",
    "off",
    "over",
    "under",
    "again",
    "further",
    "once",
    "here",
    "there",
    "all",
    "any",
    "both",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "can",
    "will",
    "just",
    "don",
    "should",
    "now",
    "how",
    "what",
    "which",
    "who",
    "whom",
    "this",
    "that",
    "these",
    "those",
    "am",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "having",
    "do",
    "does",
    "did",
    "doing",
    "of",
    "as",
    "it",
    "its",
    "i",
    "me",
    "my",
    "we",
    "our",
    "you",
    "your",
    "he",
    "him",
    "his",
    "she",
    "her",
    "they",
    "them",
    "their",
    // French
    "le",
    "la",
    "les",
    "un",
    "une",
    "des",
    "du",
    "de",
    "et",
    "ou",
    "mais",
    "donc",
    "car",
    "ni",
    "ne",
    "pas",
    "plus",
    "moins",
    "très",
    "tres",
    "au",
    "aux",
    "en",
    "dans",
    "sur",
    "sous",
    "avec",
    "sans",
    "pour",
    "par",
    "chez",
    "vers",
    "qui",
    "que",
    "quoi",
    "dont",
    "où",
    "ou",
    "ce",
    "cet",
    "cette",
    "ces",
    "son",
    "sa",
    "ses",
    "mon",
    "ma",
    "mes",
    "ton",
    "ta",
    "tes",
    "notre",
    "nos",
    "votre",
    "vos",
    "leur",
    "leurs",
    "je",
    "tu",
    "il",
    "elle",
    "on",
    "nous",
    "vous",
    "ils",
    "elles",
    "est",
    "sont",
    "été",
    "etre",
    "être",
    "avoir",
    "fait",
    "comme",
    "aussi",
    "si",
    "quand",
    "comment",
    "pourquoi",
    // German
    "der",
    "die",
    "das",
    "den",
    "dem",
    "des",
    "ein",
    "eine",
    "einer",
    "einem",
    "einen",
    "eines",
    "und",
    "oder",
    "aber",
    "doch",
    "wenn",
    "weil",
    "als",
    "auch",
    "nicht",
    "nur",
    "noch",
    "schon",
    "sehr",
    "hier",
    "dort",
    "wo",
    "was",
    "wer",
    "wie",
    "warum",
    "mit",
    "ohne",
    "für",
    "fur",
    "von",
    "zu",
    "zum",
    "zur",
    "bei",
    "nach",
    "vor",
    "über",
    "uber",
    "unter",
    "durch",
    "gegen",
    "um",
    "an",
    "am",
    "im",
    "in",
    "ist",
    "sind",
    "war",
    "waren",
    "sein",
    "haben",
    "hat",
    "hatte",
    "wird",
    "werden",
    "kann",
    "können",
    "konnen",
    "ich",
    "du",
    "er",
    "sie",
    "es",
    "wir",
    "ihr",
    "ihn",
    "ihm",
    "uns",
    "euch",
    "mein",
    "dein",
    "sein",
    "unser",
    "euer",
    // Spanish
    "el",
    "la",
    "los",
    "las",
    "un",
    "una",
    "unos",
    "unas",
    "y",
    "o",
    "pero",
    "si",
    "no",
    "que",
    "qué",
    "como",
    "cómo",
    "cuando",
    "cuándo",
    "donde",
    "dónde",
    "por",
    "para",
    "con",
    "sin",
    "sobre",
    "entre",
    "desde",
    "hasta",
    "del",
    "al",
    "es",
    "son",
    "ser",
    "estar",
    "está",
    "esta",
    "este",
    "estos",
    "estas",
    "eso",
    "esa",
    "ese",
    "hay",
    "tiene",
    "tienen",
    "hacer",
    "más",
    "mas",
    "muy",
    "ya",
    "también",
    "tambien",
    "yo",
    "tú",
    "tu",
    "él",
    "ella",
    "nosotros",
    "vosotros",
    "ellos",
    "ellas",
    "mi",
    "su",
    "sus",
    // Portuguese
    "os",
    "as",
    "um",
    "uma",
    "de",
    "do",
    "da",
    "dos",
    "das",
    "em",
    "no",
    "na",
    "nos",
    "nas",
    "por",
    "para",
    "com",
    "sem",
    "sobre",
    "entre",
    "é",
    "e",
    "ou",
    "mas",
    "não",
    "nao",
    "que",
    "se",
    "como",
    "quando",
    "onde",
    "mais",
    "muito",
    "já",
    "ja",
    "também",
    "tambem",
    // Italian
    "il",
    "lo",
    "la",
    "i",
    "gli",
    "le",
    "un",
    "uno",
    "una",
    "di",
    "del",
    "della",
    "dei",
    "delle",
    "e",
    "ed",
    "o",
    "ma",
    "se",
    "non",
    "che",
    "chi",
    "come",
    "quando",
    "dove",
    "per",
    "con",
    "senza",
    "su",
    "tra",
    "fra",
    "è",
    "sono",
    "essere",
    "avere",
    "ha",
    "hanno",
    "questo",
    "questa",
    "quello",
    "quella",
    "più",
    "piu",
    "anche",
    // Dutch
    "de",
    "het",
    "een",
    "en",
    "of",
    "maar",
    "als",
    "niet",
    "met",
    "zonder",
    "voor",
    "van",
    "op",
    "aan",
    "in",
    "uit",
    "bij",
    "naar",
    "over",
    "onder",
    "is",
    "zijn",
    "was",
    "waren",
    "heeft",
    "hebben",
    "dit",
    "dat",
    "deze",
    "die",
    "hoe",
    "wat",
    "wie",
    "waar",
    // Common across / misc
    "vs",
    "via",
    "per",
    "etc",
  ].map((w) => w.toLowerCase()),
);

const EDGE_PUNCT_RE = /^[\p{P}\p{S}\p{Z}]+|[\p{P}\p{S}\p{Z}]+$/gu;

export type FtsQueryMode = "and" | "near" | "or";

export interface BuiltFtsQuery {
  /** Primary MATCH expression (AND or NEAR). */
  primary: string;
  /** Softer OR fallback if primary returns no rows. */
  fallbackOr: string;
  /** Significant tokens after stopword filtering (or originals if too few left). */
  tokens: string[];
}

function stripEdgePunct(token: string): string {
  return token.replace(EDGE_PUNCT_RE, "").trim();
}

function quoteFtsToken(token: string): string | null {
  const cleaned = token.replace(/["']/g, " ").trim();
  if (!cleaned) return null;
  // FTS5: escape internal double quotes by doubling
  const escaped = cleaned.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Split a query into phrases (quoted) and bare tokens.
 * Preserves user "quoted phrases" as single units.
 */
export function tokenizeQuery(query: string): Array<{ type: "phrase" | "term"; value: string }> {
  const out: Array<{ type: "phrase" | "term"; value: string }> = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    if (m[1] != null) {
      const phrase = m[1].trim();
      if (phrase) out.push({ type: "phrase", value: phrase });
    } else if (m[2] != null) {
      const term = stripEdgePunct(m[2]);
      if (term) out.push({ type: "term", value: term });
    }
  }
  return out;
}

function filterStopwords(parts: Array<{ type: "phrase" | "term"; value: string }>): Array<{
  type: "phrase" | "term";
  value: string;
}> {
  const filtered = parts.filter((p) => {
    if (p.type === "phrase") return true;
    return !MULTILINGUAL_STOPWORDS.has(p.value.toLowerCase());
  });
  // If filtering would leave fewer than 2 units, keep originals (avoid empty/weak queries).
  if (filtered.length < 2 && parts.length >= 1) return parts;
  return filtered.length > 0 ? filtered : parts;
}

function joinQuoted(
  parts: Array<{ type: "phrase" | "term"; value: string }>,
  joiner: "AND" | "OR",
): string {
  const quoted = parts.map((p) => quoteFtsToken(p.value)).filter((t): t is string => Boolean(t));
  return quoted.join(` ${joiner} `);
}

/**
 * Build a multilingual FTS5 MATCH expression.
 * Content terms are AND/NEAR'd; OR fallback provided separately.
 */
export function buildFtsQuery(query: string, keywords?: string[]): BuiltFtsQuery {
  const parts = filterStopwords(tokenizeQuery(query));
  const tokens = parts.map((p) => p.value);

  let contentExpr = "";
  if (parts.length === 0) {
    contentExpr = "";
  } else if (parts.length === 1) {
    contentExpr = quoteFtsToken(parts[0]!.value) ?? "";
  } else if (parts.length <= 3) {
    // NEAR for short multi-term queries (proximity boost without English stemming)
    const quoted = parts.map((p) => quoteFtsToken(p.value)).filter((t): t is string => Boolean(t));
    contentExpr = `NEAR(${quoted.join(" ")}, 5)`;
  } else {
    contentExpr = joinQuoted(parts, "AND");
  }

  const fallbackOr = joinQuoted(parts, "OR");

  const required = (keywords ?? [])
    .map((k) => stripEdgePunct(k))
    .map((k) => quoteFtsToken(k))
    .filter((t): t is string => Boolean(t));

  const withKeywords = (base: string): string => {
    if (!base && required.length === 0) return "";
    if (!base) return required.join(" AND ");
    if (required.length === 0) return base;
    return `(${base}) AND ${required.join(" AND ")}`;
  };

  return {
    primary: withKeywords(contentExpr),
    fallbackOr: withKeywords(fallbackOr),
    tokens,
  };
}

/** Significant tokens for LIKE fallback (no stopword-only queries). */
export function significantTokens(query: string): string[] {
  return buildFtsQuery(query).tokens;
}

export function isMultilingualStopword(token: string): boolean {
  return MULTILINGUAL_STOPWORDS.has(token.toLowerCase());
}
