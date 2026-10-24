/** Memory types and layers from the H-MEM spec §4. */
export type MemoryType = "personal" | "factual" | "preference" | "general" | "procedural";
export type MemoryLayer = "short_term" | "working" | "long_term";

/** The canonical memory record (H-MEM spec §4), with agent attribution. */
export interface MemoryRecord {
  id: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  timestamp: string;
  lastAccessed: string;
  accessCount: number;
  tags: string[];
  /** Lightweight deterministic embedding (hashed bag of words, unit length). */
  embedding: number[];
  /** Runtime score: the forgetting-curve retention applied at load (1 for long-term). */
  score: number;
  confidence: number;
  source: string;
  domain: string;
  namespace: string;
  entities: string[];
  relatedTo: string[];
  supersedes: string | null;
  derivedFrom: string[];
  agentId: string;
  runId: string;
  taskId: string | null;
  /** Extension: runs in which the memory was retrieved (drives promotion to working). */
  accessRuns: string[];
  /** Extension: structured content for consumers that need more than the text (e.g. tool results). */
  payload?: unknown;
}

export type NewMemory = Pick<MemoryRecord, "content" | "type" | "layer" | "source" | "agentId" | "runId"> &
  Partial<Pick<MemoryRecord, "tags" | "confidence" | "taskId" | "derivedFrom" | "supersedes" | "payload" | "timestamp">>;

export type LedgerAction = "create" | "read" | "update" | "delete" | "promote" | "forget" | "feedback" | "hydrate";

export interface LedgerEntry {
  memoryId: string;
  action: LedgerAction;
  actor: string;
  timestamp: string;
  runId?: string;
  previousState?: Partial<MemoryRecord>;
  newState?: Partial<MemoryRecord>;
  details?: Record<string, unknown>;
}

/** One memory in a retrieval package, with the parts of its score and the reason it was chosen. */
export interface RetrievedMemory {
  id: string;
  content: string;
  payload?: unknown;
  type: MemoryType;
  layer: MemoryLayer;
  runId: string;
  agentId: string;
  fromEarlierRun: boolean;
  score: number;
  components: { similarity: number; keyword: number; recency: number; access: number; layer: number; retention: number };
  why: string;
}

/** The structured reinjection payload (H-MEM spec §8.2): not a pre-rendered string. */
export interface ContextPackage {
  schema: "hmem.context.v1";
  query: string;
  strategy: "minimal" | "task_focused" | "comprehensive";
  retrievalReason: string;
  runId: string;
  threshold: number;
  considered: number;
  memories: RetrievedMemory[];
}
