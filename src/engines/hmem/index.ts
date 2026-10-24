// H-MEM: hierarchical memory (Meterless H-MEM Agent Engine spec), minimum build:
// MemoryStoreService + MemoryRetrievalService + TrustLedgerService, with no-model mining.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MemoryEntry, RunMemory, ScoredMemoryEntry } from "../types.js";
import { TrustLedgerService } from "./ledger.js";
import { mineEvent, type RuntimeEvent } from "./mining.js";
import { MemoryRetrievalService } from "./retrieval.js";
import { MemoryStoreService } from "./store.js";
import type { MemoryLayer, MemoryRecord } from "./types.js";

export { cosine, embed, EMBEDDING_DIM } from "./embedding.js";
export { TrustLedgerService } from "./ledger.js";
export { mineEvent, parseMemoryStrings, type RuntimeEvent } from "./mining.js";
export { MemoryRetrievalService } from "./retrieval.js";
export { MemoryStoreService, retention, DECAY_HOURS, FORGET_BELOW } from "./store.js";
export type * from "./types.js";

export interface HMemOptions {
  /** Working + long-term JSON files (default data/memory). */
  dataDir?: string;
  /** Ledger and retrieval traces (default logs/hmem). */
  logDir?: string;
  now?: () => Date;
}

export interface HMemRunStats {
  retrieved_from_prior_runs: number;
  retrieved_this_run: number;
  created_this_run: number;
  promoted_this_run: number;
  memories_by_layer: Record<MemoryLayer, number>;
}

/** Shape of a Researcher tool-result entry (see agents/researcher.ts). */
interface ToolResultContent {
  tool: string;
  label: string;
  row_count: number;
  sections: Array<{ section_id: string; heading: string; snippet?: string }>;
}

export class HMem {
  readonly ledger: TrustLedgerService;
  readonly store: MemoryStoreService;
  readonly retrieval: MemoryRetrievalService;
  /** runId|section_id -> ids of the tool-result memories that surfaced the section in that run. */
  private readonly surfacedBy = new Map<string, string[]>();
  private readonly hydrated = new Set<string>();

  constructor(opts: HMemOptions = {}) {
    const dataDir = resolve(opts.dataDir ?? process.env.HMEM_DIR ?? "data/memory");
    const logDir = resolve(opts.logDir ?? process.env.HMEM_LOG_DIR ?? "logs/hmem");
    this.ledger = new TrustLedgerService(join(logDir, "ledger.jsonl"));
    this.store = new MemoryStoreService({ dir: dataDir, ledger: this.ledger, now: opts.now });
    this.retrieval = new MemoryRetrievalService(this.store, this.ledger, join(logDir, "retrievals.jsonl"), opts.now);
  }

  /** Run start: warm-start the tiers once per run. */
  startRun(runId: string): void {
    if (this.hydrated.has(runId)) return;
    this.hydrated.add(runId);
    this.store.hydrate(runId);
  }

  /** Mines a runtime event into memories (no-model path), applying the promotion rules. */
  observe(e: RuntimeEvent): MemoryRecord[] {
    this.startRun(e.runId);
    const created = mineEvent(e).map((m) => this.store.add(m));
    if (e.kind === "tool_result") {
      for (const id of e.sectionIds) {
        const key = `${e.runId}|${id}`;
        this.surfacedBy.set(key, [...new Set([...(this.surfacedBy.get(key) ?? []), ...created.map((c) => c.id)])]);
      }
    }
    if (e.kind === "verdict" && e.quoteVerified && (e.verdict === "supported" || e.verdict === "qualified")) {
      // a Critic-verified fact becomes long-term factual memory, derived from what surfaced its sections
      const derivedFrom = [...new Set([...created.map((c) => c.id), ...e.sectionIds.flatMap((s) => this.surfacedBy.get(`${e.runId}|${s}`) ?? [])])];
      created.push(
        this.store.add({
          content: `${e.sectionIds.join(", ")}: ${e.claimText} (${e.verdict} by the Critic${e.quote ? `; quote: "${e.quote.slice(0, 240)}"` : ""})`,
          type: "factual",
          layer: "long_term",
          source: "critic:verified",
          agentId: e.agentId,
          runId: e.runId,
          taskId: e.taskId,
          tags: ["verified", e.verdict, ...e.sectionIds],
          confidence: e.verdict === "supported" ? 0.9 : 0.7,
          derivedFrom,
        }),
      );
    }
    return created;
  }

  endRun(runId: string): void {
    this.store.endRun(runId);
  }

  /** The RunMemory the Researcher uses: tool results in, cross-run tool-result memories out. */
  runMemory(runId: string, agentId = "researcher"): RunMemory {
    this.startRun(runId);
    return {
      store: async (entry: MemoryEntry) => {
        const c = entry.content as Partial<ToolResultContent>;
        const sections = Array.isArray(c.sections) ? c.sections : [];
        this.observe({
          kind: "tool_result",
          agentId,
          runId,
          tool: String(c.tool ?? entry.kind),
          label: String(c.label ?? ""),
          rowCount: Number(c.row_count ?? sections.length),
          sectionIds: sections.map((s) => s.section_id).filter(Boolean),
          headings: sections.map((s) => s.heading ?? ""),
          payload: entry.content,
        });
      },
      retrieve: async (query: string, limit: number): Promise<ScoredMemoryEntry[]> => {
        const pkg = this.retrieval.retrieve(query, { runId, agentId, limit, sources: ["tool:"] });
        return pkg.memories.map((m) => ({
          kind: "tool_result",
          content: m.payload ?? { tool: m.content.split(" ")[0], label: m.content, row_count: 0, sections: [] },
          tags: [],
          score: m.score,
          origin: m.fromEarlierRun ? "earlier_run" : "this_run",
        }));
      },
    };
  }

  stats(runId: string): HMemRunStats {
    const reads = this.ledger.query({ runId, action: "read" });
    const unique = (xs: typeof reads) => new Set(xs.map((r) => r.memoryId)).size;
    return {
      retrieved_from_prior_runs: unique(reads.filter((r) => r.details?.fromEarlierRun === true)),
      retrieved_this_run: unique(reads),
      created_this_run: this.ledger.query({ runId, action: "create" }).length,
      promoted_this_run: this.ledger.query({ runId, action: "promote" }).length,
      memories_by_layer: this.store.counts(),
    };
  }
}

/**
 * A self-contained H-MEM for one process (tests, the CLI scripts): its own temporary data and log
 * directories, so nothing is shared with the app's memory.
 */
export class InMemoryRunMemory implements RunMemory {
  private readonly mem: RunMemory;

  constructor(runId = "local") {
    const dir = mkdtempSync(join(tmpdir(), "hmem-"));
    this.mem = new HMem({ dataDir: join(dir, "data"), logDir: join(dir, "logs") }).runMemory(runId);
  }

  store(entry: MemoryEntry): Promise<void> {
    return this.mem.store(entry);
  }

  retrieve(query: string, limit: number): Promise<ScoredMemoryEntry[]> {
    return this.mem.retrieve(query, limit);
  }
}
