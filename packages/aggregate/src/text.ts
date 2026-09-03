/**
 * Text normalization for lexical similarity.
 *
 * Deliberately small and deliberately conservative. Every transform here
 * either provably helps recall on the eval corpus or it comes out — this is
 * the layer where "clever" preprocessing quietly destroys precision and nobody
 * notices for months.
 */

/** Casefold, strip punctuation, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stopwords.
 *
 * Includes the usual function words plus **feedback-specific noise**: "please",
 * "need", "want", "add", "would", "could". Those appear in a large fraction of
 * feature requests and carry no topical signal, so leaving them in makes every
 * request look mildly similar to every other request — which inflates recall
 * and destroys precision exactly where it matters.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as',
  'at', 'back', 'be', 'because', 'been', 'before', 'being', 'but', 'by', 'can',
  'cannot', 'cant', 'could', 'did', 'do', 'does', 'doing', 'done', 'dont',
  'each', 'even', 'ever', 'every', 'for', 'from', 'get', 'gets', 'getting',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'him', 'his', 'how',
  'i', 'if', 'im', 'in', 'into', 'is', 'it', 'its', 'ive', 'just', 'like',
  'me', 'more', 'most', 'much', 'my', 'no', 'not', 'now', 'of', 'off', 'on',
  'one', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'she', 'so',
  'some', 'still', 'such', 'than', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'thing', 'things', 'this', 'those', 'through',
  'to', 'too', 'under', 'until', 'up', 'us', 'use', 'used', 'using', 'very',
  'was', 'way', 'we', 'well', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  // feedback boilerplate — high frequency, zero topical content
  'add', 'adding', 'need', 'needs', 'needed', 'want', 'wants', 'wanted',
  'please', 'pls', 'plz', 'thanks', 'thank', 'hi', 'hello', 'app', 'guys',
  'feature', 'request', 'support', 'able', 'allow', 'let', 'make', 'give',
]);

/**
 * Conservative suffix stripping.
 *
 * Not a real stemmer. It collapses the four inflections that actually matter
 * in feedback — plurals and verb tense — and touches nothing else. A full
 * Porter stemmer conflates too aggressively for this domain ("universal" and
 * "universe"), and the failure is invisible until a cluster is quietly wrong.
 *
 * Guarded by a minimum stem length so short words survive intact.
 */
export function stem(word: string): string {
  if (word.length <= 3) return word;

  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (word.endsWith('ses') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('es') && word.length > 4 && /(?:ch|sh|x|z|s)es$/.test(word)) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) {
    return word.slice(0, -1);
  }
  if (word.endsWith('ing') && word.length > 5) {
    const base = word.slice(0, -3);
    // "running" -> "run", not "runn"
    return /([^aeiou])\1$/.test(base) ? base.slice(0, -1) : base;
  }
  if (word.endsWith('ed') && word.length > 4) {
    const base = word.slice(0, -2);
    return /([^aeiou])\1$/.test(base) ? base.slice(0, -1) : base;
  }
  return word;
}

export interface TokenizeOptions {
  /** Default true. */
  removeStopwords?: boolean;
  /** Default true. */
  applyStemming?: boolean;
  /** Tokens shorter than this are dropped. Default 3. */
  minLength?: number;
  /**
   * Emit adjacent token pairs alongside unigrams. Default false.
   *
   * Bigrams are what distinguish "export csv" from "csv missing" — the
   * `feature-vs-bug-same-nouns` trap, where unigram overlap is total.
   */
  bigrams?: boolean;
}

export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const removeStopwords = options.removeStopwords ?? true;
  const applyStemming = options.applyStemming ?? true;
  const minLength = options.minLength ?? 3;

  let tokens = normalize(text).split(' ').filter((t) => t !== '');
  if (removeStopwords) tokens = tokens.filter((t) => !STOPWORDS.has(t));
  tokens = tokens.filter((t) => t.length >= minLength);
  if (applyStemming) tokens = tokens.map(stem);

  if (options.bigrams === true) {
    const pairs: string[] = [];
    for (let i = 0; i + 1 < tokens.length; i++) pairs.push(`${tokens[i]}_${tokens[i + 1]}`);
    return [...tokens, ...pairs];
  }
  return tokens;
}
