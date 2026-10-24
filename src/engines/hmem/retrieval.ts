import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cosine, embed, tokens } from "./embedding.js";
import type { TrustLedgerService } from "./ledger.js";
import type { MemoryStoreService } from "./store.js";
import type { ContextPackage, MemoryLayer, MemoryRecord, RetrievedMemory } from "./types.js";

/** Hybrid ranking weights (H-MEM spec §8.1), applied before the forgetting-curve retention. */
export const WEIGHTS = { similarity: 0.55, keyword: 0.1, recency: 0.15, access: 0.1, layer: 0.1 } as const;
const LAYER_WEIGHT: Record<MemoryLayer, number> = { long_term: 1, working: 0.7, short_term: 0.4 };
/** Recency half-life in hours for the recency boost. */
const RECENCY_HOURS = 72;
export const DEFAULT_THRESHOLD = 0.2;
/** A memory must share this much embedding similarity, or at least one keyword, with the query. */
export const MIN_SIMILARITY = 0.05;
export const DEFAULT_LIMIT = 5;

export interface RetrieveOptions {
  runId: string;
  agentId: string;
  limit?: number;
  threshold?: number;
  /** Restrict to memories from these sources (prefix match, e.g. "tool:"). */
  sources?: string[];
}

/**
 * MemoryRetrievalService (H-MEM spec §8): hybrid ranking over every hydrated memory, returning a
 * structured context package with trace metadata, and recording each returned memory's access.
 */
export class MemoryRetrievalService {
  constructor(
    private readonly store: MemoryStoreService,
    private readonly ledger: TrustLedgerService,
    private readonly traceFile?: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Scores one memory against a query (exported for tests through `rank`). */
  private scoreOne(r: MemoryRecord, q: number[], qTokens: Set<string>, runId: string, now: Date): RetrievedMemory {
    const similarity = cosine(q, r.embedding);
    const memTokens = new Set(tokens(`${r.content} ${r.tags.join(" ")}`));
    const keyword = qTokens.size ? [...qTokens].filter((t) => memTokens.has(t)).length / qTokens.size : 0;
    const hours = Math.max(0, (now.getTime() - new Date(r.lastAccessed).getTime()) / 3_600_000);
    const recency = Math.exp(-hours / RECENCY_HOURS);
    const access = Math.min(1, Math.log1p(r.accessCount) / Math.log(10));
    const layer = LAYER_WEIGHT[r.layer];
    const raw =
      WEIGHTS.similarity * similarity + WEIGHTS.keyword * keyword + WEIGHTS.recency * recency + WEIGHTS.access * access + WEIGHTS.layer * layer;
    const superseded = [...this.store.all()].some((o) => o.supersedes === r.id);
    const score = raw * r.score * (superseded ? 0.5 : 1);
    const fromEarlierRun = r.runId !== runId;
    const why =
      `similarity ${similarity.toFixed(2)}, keywords ${keyword.toFixed(2)}, ${r.layer.replace("_", "-")}` +
      `${r.accessCount ? `, accessed ${r.accessCount}x` : ""}${r.layer !== "long_term" ? `, retention ${r.score.toFixed(2)}` : ""}` +
      `${fromEarlierRun ? `, from earlier run ${r.runId.slice(0, 8)}` : ", this run"}${superseded ? ", superseded" : ""}`;
    return {
      id: r.id,
      content: r.content,
      payload: r.payload,
      type: r.type,
      layer: r.layer,
      runId: r.runId,
      agentId: r.agentId,
      fromEarlierRun,
      score: Number(score.toFixed(4)),
      components: {
        similarity: Number(similarity.toFixed(4)),
        keyword: Number(keyword.toFixed(4)),
        recency: Number(recency.toFixed(4)),
        access: Number(access.toFixed(4)),
        layer,
        retention: Number(r.score.toFixed(4)),
      },
      why,
    };
  }

  /** Ranks without recording access (used by `retrieve`, and by tests). */
  rank(query: string, opts: RetrieveOptions): { ranked: RetrievedMemory[]; considered: number } {
    const now = this.now();
    const q = embed(query);
    const qTokens = new Set(tokens(query));
    const pool = this.store.all().filter((r) => !opts.sources || opts.sources.some((s) => r.source.startsWith(s)));
    const ranked = pool.map((r) => this.scoreOne(r, q, qTokens, opts.runId, now)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { ranked, considered: pool.length };
  }

  retrieve(query: string, opts: RetrieveOptions): ContextPackage {
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const { ranked, considered } = this.rank(query, opts);
    // de-duplicate identical content (the same tool result observed in two runs), keeping the best
    const seen = new Set<string>();
    const memories = ranked
      // relevance gate: recency and layer alone never make an unrelated memory relevant
      .filter((m) => m.components.similarity >= MIN_SIMILARITY || m.components.keyword > 0)
      .filter((m) => m.score >= threshold)
      .filter((m) => (seen.has(m.content) ? false : (seen.add(m.content), true)))
      .slice(0, limit);
    for (const m of memories) {
      this.store.touch(m.id, opts.runId, opts.agentId);
      this.ledger.append({
        memoryId: m.id,
        action: "read",
        actor: opts.agentId,
        runId: opts.runId,
        details: { query: query.slice(0, 200), score: m.score, fromEarlierRun: m.fromEarlierRun, originRunId: m.runId, why: m.why },
      });
    }
    const earlier = memories.filter((m) => m.fromEarlierRun).length;
    const pkg: ContextPackage = {
      schema: "hmem.context.v1",
      query,
      strategy: "task_focused",
      retrievalReason: `top ${limit} of ${considered} memories above ${threshold} by hybrid score (similarity, keywords, recency, access, layer, retention); ${earlier} from earlier runs`,
      runId: opts.runId,
      threshold,
      considered,
      memories,
    };
    if (this.traceFile) {
      mkdirSync(dirname(this.traceFile), { recursive: true });
      appendFileSync(
        this.traceFile,
        `${JSON.stringify({ ts: this.now().toISOString(), runId: opts.runId, agentId: opts.agentId, query: query.slice(0, 200), considered, returned: memories.map((m) => ({ id: m.id, score: m.score, fromEarlierRun: m.fromEarlierRun, why: m.why })) })}\n`,
        "utf-8",
      );
    }
    return pkg;
  }
}
