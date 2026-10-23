import type { Verdict } from "../agents/types.js";

/** One judged (claim, cited section) pair. */
export interface Fact {
  section_id: string;
  act_id: string;
  section_no: string;
  heading: string;
  text: string;
  source: string;
  verdict: Verdict;
  claim_id: string;
  reason: string;
  quote: string | null;
  ts: string;
}

export interface FactFilter {
  claim_id?: string;
  section_id?: string;
  verdict?: Verdict;
}

/** What the agents have established about the statutes, fact by fact. */
export interface WorldModel {
  addFact(f: Fact): Promise<void>;
  getFacts(filter?: FactFilter): Promise<Fact[]>;
}

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
