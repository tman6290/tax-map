// World Model (Meterless World Model Agent Engine spec), minimum build:
// WorldStoreService + IngestPipelineService + ContextBuilderService, over a typed graph.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Fact, FactFilter, WorldModel } from "../types.js";
import { ContextBuilderService } from "./context.js";
import { ids } from "./ids.js";
import { IngestPipelineService, type RunIngestInput, type Stage } from "./ingest.js";
import { WorldStoreService } from "./store.js";
import type { WMEdge, WMEntity } from "./types.js";

export { ContextBuilderService, CONTEXT_SCHEMA, type ClaimContext } from "./context.js";
export { contentHash, ids, stableStringify } from "./ids.js";
export { IngestPipelineService, STAGES, type IngestReport, type RunIngestInput, type Stage } from "./ingest.js";
export { WorldStoreService, type StoreHealth } from "./store.js";
export type * from "./types.js";

export interface WorldModelOptions {
  /** world.json (default data/world_model). */
  dataDir?: string;
  /** events.jsonl (default logs/world_model). */
  logDir?: string;
}

export interface WorldRunStats {
  facts_total: number;
  verified_facts_total: number;
  facts_this_run: number;
  verified_facts_this_run: number;
  entities: number;
  edges: number;
  runs_ingested: number;
}

const VERIFIED = new Set(["supported", "qualified"]);

export class WorldModelEngine {
  readonly store: WorldStoreService;
  readonly ingest: IngestPipelineService;
  readonly context: ContextBuilderService;

  constructor(opts: WorldModelOptions = {}) {
    const dataDir = resolve(opts.dataDir ?? process.env.WM_DIR ?? "data/world_model");
    const logDir = resolve(opts.logDir ?? process.env.WM_LOG_DIR ?? "logs/world_model");
    this.store = new WorldStoreService(dataDir, join(logDir, "events.jsonl"));
    this.ingest = new IngestPipelineService(this.store);
    this.context = new ContextBuilderService(this.store);
  }

  ingestRun(r: RunIngestInput, opts: { stopAfter?: Stage } = {}) {
    return this.ingest.ingestRun(r, opts);
  }

  /** Writes one judged (claim, section) pair straight through to the graph (the Critic's path). */
  writeFact(runId: string, f: Fact, agentId = "critic"): void {
    const s = this.store;
    const at = f.ts;
    const prov = { source: f.source, runId, agentId, taskId: null, createdAt: at, updatedAt: at };
    const agg = { mentionCount: 0, firstSeenAt: null, lastSeenAt: null };
    const entity = (type: WMEntity["type"], id: string, name: string, properties: Record<string, unknown>, confidence = 1): WMEntity => ({
      id,
      type,
      name,
      properties,
      provenance: prov,
      lifecycle: { state: "active", confidence },
      aggregates: agg,
    });
    const edge = (type: WMEdge["type"], from: string, to: string, properties: Record<string, unknown> = {}): WMEdge => ({
      id: ids.edge(type, from, to),
      type,
      from,
      to,
      directed: true,
      runId,
      properties,
    });
    const sec = ids.section(f.section_id);
    const claim = ids.claim(runId, f.claim_id);
    const verdict = ids.verdict(runId, f.claim_id);
    s.upsertEntity(entity("act", ids.act(f.act_id), f.act_id, { act_id: f.act_id }));
    s.upsertEntity(entity("section", sec, f.section_id, { section_id: f.section_id, act_id: f.act_id, section_no: f.section_no, heading: f.heading, text: f.text }));
    s.upsertEntity(entity("claim", claim, f.claim_id, { claim_id: f.claim_id }));
    s.upsertEntity(entity("verdict", verdict, `${f.claim_id}: ${f.verdict}`, { claim_id: f.claim_id, verdict: f.verdict, reason: f.reason, quote: f.quote }));
    s.upsertEdge(edge("part_of", sec, ids.act(f.act_id)));
    s.upsertEdge(edge("cites", claim, sec));
    s.upsertEdge(edge("judges", verdict, claim, { verdict: f.verdict }));
    s.commit();
    s.event({ type: "fact_written", runId, claimId: f.claim_id, sectionId: f.section_id, verdict: f.verdict, agentId });
  }

  /** Facts read back from the graph: verdict -> judged claim -> cited sections. */
  facts(filter: FactFilter & { run_id?: string } = {}): Fact[] {
    const s = this.store;
    const out: Fact[] = [];
    for (const v of s.listEntities("verdict")) {
      if (filter.run_id && v.provenance.runId !== filter.run_id) continue;
      if (filter.verdict && v.properties.verdict !== filter.verdict) continue;
      for (const { entity: claim } of s.neighbors(v.id, { type: "judges", direction: "out" })) {
        const claimId = String(claim.properties.claim_id ?? claim.name);
        if (filter.claim_id && claimId !== filter.claim_id) continue;
        for (const { entity: sec } of s.neighbors(claim.id, { type: "cites", direction: "out" })) {
          const sectionId = String(sec.properties.section_id);
          if (filter.section_id && sectionId !== filter.section_id) continue;
          out.push({
            section_id: sectionId,
            act_id: String(sec.properties.act_id ?? ""),
            section_no: String(sec.properties.section_no ?? ""),
            heading: String(sec.properties.heading ?? ""),
            text: String(sec.properties.text ?? ""),
            source: v.provenance.source,
            verdict: v.properties.verdict as Fact["verdict"],
            claim_id: claimId,
            reason: String(v.properties.reason ?? ""),
            quote: (v.properties.quote as string | null) ?? null,
            ts: v.provenance.updatedAt,
            run_id: v.provenance.runId,
          });
        }
      }
    }
    return out.sort((a, b) => (a.run_id ?? "").localeCompare(b.run_id ?? "") || a.claim_id.localeCompare(b.claim_id) || a.section_id.localeCompare(b.section_id));
  }

  verifiedFacts(runId?: string): Fact[] {
    return this.facts(runId ? { run_id: runId } : {}).filter((f) => VERIFIED.has(f.verdict));
  }

  stats(runId: string): WorldRunStats {
    const all = this.facts();
    const h = this.store.health();
    return {
      facts_total: all.length,
      verified_facts_total: all.filter((f) => VERIFIED.has(f.verdict)).length,
      facts_this_run: all.filter((f) => f.run_id === runId).length,
      verified_facts_this_run: all.filter((f) => f.run_id === runId && VERIFIED.has(f.verdict)).length,
      entities: Object.values(h.entities).reduce((n, x) => n + x, 0),
      edges: h.edges,
      runs_ingested: h.runsIngested,
    };
  }

  /** The WorldModel interface for one run, so the Critic writes through the engine. */
  forRun(runId: string): WorldModel {
    return {
      addFact: async (f: Fact) => this.writeFact(runId, f),
      getFacts: async (filter?: FactFilter) => this.facts({ ...filter, run_id: runId }),
    };
  }
}

/** A self-contained World Model on temporary directories (tests, the CLI scripts). */
export class InMemoryWorldModel implements WorldModel {
  private readonly wm: WorldModel;

  constructor(runId = "local") {
    const dir = mkdtempSync(join(tmpdir(), "wm-"));
    this.wm = new WorldModelEngine({ dataDir: join(dir, "data"), logDir: join(dir, "logs") }).forRun(runId);
  }

  addFact(f: Fact): Promise<void> {
    return this.wm.addFact(f);
  }

  getFacts(filter?: FactFilter): Promise<Fact[]> {
    return this.wm.getFacts(filter);
  }
}
