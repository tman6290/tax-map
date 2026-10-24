import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { embed, EMBEDDING_DIM } from "./embedding.js";
import type { TrustLedgerService } from "./ledger.js";
import type { MemoryLayer, MemoryRecord, NewMemory } from "./types.js";

/** Forgetting-curve time constants (hours) per non-long-term layer; long-term does not decay. */
export const DECAY_HOURS: Record<Exclude<MemoryLayer, "long_term">, number> = { short_term: 24, working: 7 * 24 };
/** Below this retention a non-long-term memory is forgotten at load. */
export const FORGET_BELOW = 0.05;
/** The short-term memories of recent runs kept for the next run (they decay fast). */
const SPILL_LIMIT = 300;

const SECTION_RE = /\b(?:NTA|NTAA|NRSEA|JRBEA)-2025-s\d+\b/g;
const ACT_RE = /\b(?:NTAA|NRSEA|JRBEA|NTA)-2025\b/g;

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Retention of a memory last accessed at `lastAccessed`, at time `now` (exponential forgetting curve). */
export function retention(layer: MemoryLayer, lastAccessed: string, now: Date): number {
  if (layer === "long_term") return 1;
  const hours = Math.max(0, (now.getTime() - new Date(lastAccessed).getTime()) / 3_600_000);
  return Math.exp(-hours / DECAY_HOURS[layer]);
}

export interface StoreOptions {
  dir: string;
  ledger: TrustLedgerService;
  now?: () => Date;
}

/**
 * MemoryStoreService (H-MEM spec §5, §7): tiered persistence, CRUD, decay and promotion.
 * Short-term memories live in process for their run; at the end of a run they are spilled to a
 * fast-decaying carry-over file so the next run can still retrieve them. Working and long-term
 * memories are persisted as JSON under `dir` on every change.
 */
export class MemoryStoreService {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly now: () => Date;

  constructor(private readonly opts: StoreOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  private file(name: "working" | "long_term" | "short_term_spill"): string {
    return join(this.opts.dir, `${name}.json`);
  }

  private read(name: "working" | "long_term" | "short_term_spill"): MemoryRecord[] {
    const f = this.file(name);
    if (!existsSync(f)) return [];
    try {
      return JSON.parse(readFileSync(f, "utf-8")) as MemoryRecord[];
    } catch {
      return [];
    }
  }

  /**
   * Warm start (H-MEM spec §5): hydrate working + long-term (and the spilled short-term of earlier
   * runs), merge with this process's short-term, de-duplicate by id, backfill missing embeddings,
   * and apply the forgetting curve to every non-long-term record.
   */
  hydrate(runId: string): { loaded: number; forgotten: number; backfilled: number } {
    const now = this.now();
    let forgotten = 0;
    let backfilled = 0;
    const incoming = [...this.read("long_term"), ...this.read("working"), ...this.read("short_term_spill")];
    for (const r of incoming) {
      const existing = this.records.get(r.id);
      // de-duplicate by id: the in-process copy (this run's short-term) wins, else the most accessed
      if (existing && existing.accessCount >= r.accessCount) continue;
      this.records.set(r.id, { ...r, accessRuns: Array.isArray(r.accessRuns) ? r.accessRuns : [] });
    }
    for (const r of [...this.records.values()]) {
      if (!Array.isArray(r.embedding) || r.embedding.length !== EMBEDDING_DIM) {
        r.embedding = embed(r.content);
        backfilled++;
      }
      r.score = retention(r.layer, r.lastAccessed, now);
      if (r.layer !== "long_term" && r.score < FORGET_BELOW) {
        this.records.delete(r.id);
        forgotten++;
        this.opts.ledger.append({ memoryId: r.id, action: "forget", actor: "MemoryStoreService", runId, details: { layer: r.layer, retention: r.score } });
      }
    }
    this.persist();
    this.opts.ledger.append({ memoryId: "*", action: "hydrate", actor: "MemoryStoreService", runId, details: { loaded: this.records.size, forgotten, backfilled } });
    return { loaded: this.records.size, forgotten, backfilled };
  }

  /** Normalisation and enrichment (H-MEM spec §7): domain, namespace, entities, related memories. */
  private enrich(r: MemoryRecord): void {
    const sections = r.content.match(SECTION_RE) ?? [];
    const acts: string[] = [...(r.content.match(ACT_RE) ?? []), ...sections.map((s) => s.replace(/-s\d+$/, ""))];
    r.entities = [...new Set([...sections, ...acts, ...r.tags.filter((t) => /^[a-z_]+$/.test(t))])].slice(0, 10);
    r.domain = r.domain || (r.source.startsWith("tool:") ? "tooling" : r.source.startsWith("critic") ? "verification" : "orchestration");
    r.namespace = `${r.domain}/${r.source.replace(/^tool:/, "").replace(/[^a-z_]+/gi, "_").toLowerCase()}`;
    const shared = [...this.records.values()].filter((o) => o.id !== r.id && o.entities.some((e) => e.includes("-s") && r.entities.includes(e)));
    r.relatedTo = shared.slice(0, 5).map((o) => o.id);
  }

  add(m: NewMemory): MemoryRecord {
    const at = m.timestamp ?? this.now().toISOString();
    // short-term ids are per run (the same observation in another run is a new observation);
    // working and long-term ids depend on content alone, so a fact is stored once
    const id = `mem_${hash(m.layer === "short_term" ? `${m.runId}|${m.content}` : `${m.layer}|${m.content}`)}`;
    const existing = this.records.get(id);
    if (existing) {
      const before = { tags: existing.tags, derivedFrom: existing.derivedFrom, confidence: existing.confidence };
      existing.tags = [...new Set([...existing.tags, ...(m.tags ?? [])])];
      existing.derivedFrom = [...new Set([...existing.derivedFrom, ...(m.derivedFrom ?? [])])];
      existing.confidence = Math.max(existing.confidence, m.confidence ?? existing.confidence);
      this.persist();
      this.opts.ledger.append({ memoryId: id, action: "update", actor: m.agentId, runId: m.runId, previousState: before, newState: { tags: existing.tags, derivedFrom: existing.derivedFrom, confidence: existing.confidence } });
      return existing;
    }
    const r: MemoryRecord = {
      id,
      content: m.content,
      type: m.type,
      layer: m.layer,
      timestamp: at,
      lastAccessed: at,
      accessCount: 0,
      tags: m.tags ?? [],
      embedding: embed(m.content),
      score: 1,
      confidence: m.confidence ?? 0.6,
      source: m.source,
      domain: "",
      namespace: "",
      entities: [],
      relatedTo: [],
      supersedes: m.supersedes ?? null,
      derivedFrom: m.derivedFrom ?? [],
      agentId: m.agentId,
      runId: m.runId,
      taskId: m.taskId ?? null,
      accessRuns: [],
      ...(m.payload !== undefined ? { payload: m.payload } : {}),
    };
    this.enrich(r);
    this.records.set(id, r);
    this.persist();
    this.opts.ledger.append({ memoryId: id, action: "create", actor: m.agentId, runId: m.runId, newState: { layer: r.layer, type: r.type, source: r.source, content: r.content.slice(0, 200) } });
    return r;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  all(): MemoryRecord[] {
    return [...this.records.values()];
  }

  /**
   * Records an access in `runId`. A short-term memory retrieved in two different runs is promoted to
   * working (and so persisted durably).
   */
  touch(id: string, runId: string, actor: string): MemoryRecord | undefined {
    const r = this.records.get(id);
    if (!r) return undefined;
    r.lastAccessed = this.now().toISOString();
    r.accessCount++;
    if (!r.accessRuns.includes(runId)) r.accessRuns.push(runId);
    if (r.layer === "short_term" && r.accessRuns.length >= 2) {
      r.layer = "working";
      this.opts.ledger.append({ memoryId: id, action: "promote", actor: "MemoryStoreService", runId, previousState: { layer: "short_term" }, newState: { layer: "working" }, details: { accessRuns: r.accessRuns, triggeredBy: actor } });
    }
    this.persist();
    return r;
  }

  remove(id: string, actor: string, runId?: string): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    this.records.delete(id);
    this.persist();
    this.opts.ledger.append({ memoryId: id, action: "delete", actor, runId, previousState: { layer: r.layer, content: r.content.slice(0, 200) } });
    return true;
  }

  /** End of a run: this run's short-term memories are kept as fast-decaying carry-over for the next run. */
  endRun(runId: string): number {
    const spilled = this.all().filter((r) => r.layer === "short_term");
    this.persist();
    return spilled.filter((r) => r.runId === runId).length;
  }

  /** Write-through: working and long-term files, plus the short-term carry-over. */
  persist(): void {
    mkdirSync(this.opts.dir, { recursive: true });
    const by = (layer: MemoryLayer) => this.all().filter((r) => r.layer === layer);
    writeFileSync(this.file("working"), JSON.stringify(by("working")), "utf-8");
    writeFileSync(this.file("long_term"), JSON.stringify(by("long_term")), "utf-8");
    const spill = by("short_term")
      .sort((a, b) => b.lastAccessed.localeCompare(a.lastAccessed))
      .slice(0, SPILL_LIMIT);
    writeFileSync(this.file("short_term_spill"), JSON.stringify(spill), "utf-8");
  }

  counts(): Record<MemoryLayer, number> {
    const c: Record<MemoryLayer, number> = { short_term: 0, working: 0, long_term: 0 };
    for (const r of this.records.values()) c[r.layer]++;
    return c;
  }
}
