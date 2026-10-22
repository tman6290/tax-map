export interface MemoryEntry {
  kind: string;
  content: unknown;
  tags: string[];
}

export interface ScoredMemoryEntry extends MemoryEntry {
  score: number;
}

/** Per-run memory the agents write tool results to and read summaries from. */
export interface RunMemory {
  store(entry: MemoryEntry): Promise<void>;
  retrieve(query: string, limit: number): Promise<ScoredMemoryEntry[]>;
}
