/**
 * Deterministic lightweight embedding: a hashed bag of words in a fixed number of dimensions,
 * L2-normalised, so cosine similarity is a dot product. No model, no network, same input -> same vector.
 */
export const EMBEDDING_DIM = 256;

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in into is it its of on or that the this to was were will with which what does do my your shall".split(" "),
);

/** A light, deterministic plural stemmer: "taxes" -> "tax", "levies" -> "levy", "returns" -> "return". */
export function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(?:s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !/\d/.test(t)) return t.slice(0, -1);
  return t;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []).filter((t) => t.length >= 2 && !STOPWORDS.has(t)).map(stem);
}

/** FNV-1a 32-bit. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function embed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const t of tokens(text)) v[fnv1a(t) % EMBEDDING_DIM]! += 1;
  const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return Math.max(0, Math.min(1, dot));
}
