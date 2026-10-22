// PLACEHOLDER: an in-memory RunMemory with naive keyword scoring, so the agents can run before
// the real hierarchical memory engine exists. Nothing persists beyond the process, and scoring
// is a plain count of query words found in an entry's tags and serialised content.
import type { MemoryEntry, RunMemory, ScoredMemoryEntry } from "../types.js";

const STOPWORDS = new Set(["the", "and", "for", "what", "does", "have", "with", "that", "this", "are", "my"]);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

export class InMemoryRunMemory implements RunMemory {
  private readonly entries: MemoryEntry[] = [];

  async store(entry: MemoryEntry): Promise<void> {
    this.entries.push(entry);
  }

  async retrieve(query: string, limit: number): Promise<ScoredMemoryEntry[]> {
    const terms = words(query);
    return this.entries
      .map((e, i) => {
        const haystack = `${e.tags.join(" ")} ${JSON.stringify(e.content)}`.toLowerCase();
        const score = terms.reduce((n, t) => n + (haystack.includes(t) ? 1 : 0), 0);
        return { entry: { ...e, score }, i };
      })
      .sort((a, b) => b.entry.score - a.entry.score || b.i - a.i) // ties: newest first
      .slice(0, limit)
      .map(({ entry }) => entry);
  }
}
