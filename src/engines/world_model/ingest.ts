import { contentHash, ids } from "./ids.js";
import type { WorldStoreService } from "./store.js";
import type { EdgeType, EntityType, WMEdge, WMEntity } from "./types.js";

/** What a finished run hands the World Model. */
export interface RunIngestInput {
  runId: string;
  finishedAt: string;
  sections: Array<{ section_id: string; act_id: string; section_no: string; heading: string; text: string }>;
  definitions: Array<{ section_id: string; term: string; definition: string }>;
  claims: Array<{ id: string; type?: string; text: string; section_ids: string[]; tier?: string; agency?: string | null }>;
  checked: Array<{
    claim: { id: string; text: string; section_ids: string[] };
    verdict: string;
    reason: string;
    quote: string | null;
    quote_verified: boolean;
    qualifier: string | null;
    definitions_used?: string[];
    definitions?: Array<{ section_id: string; term: string }>;
  }>;
  actTitles?: Record<string, string>;
}

/** The canonical ingest order (World Model spec §6.1), each stage idempotent and checkpointed. */
export const STAGES = [
  "reconcile",
  "classify",
  "persist_primary",
  "score",
  "infer_derived",
  "persist_edges",
  "rebuild_views",
  "patch_items",
  "rebuild_aggregates",
  "mark_stale",
] as const;
export type Stage = (typeof STAGES)[number];

export interface IngestReport {
  runId: string;
  skipped: boolean;
  resumedFrom: Stage | null;
  stagesRun: Stage[];
  changes: number;
}

const CONFIDENCE: Record<string, number> = { supported: 0.9, qualified: 0.6, struck: 0.1, unchecked: 0 };

/**
 * IngestPipelineService: turns a finished run into world state. Stable ids and change detection make
 * every stage idempotent, a per-run checkpoint makes the pipeline resumable after an interruption, and
 * a run that was already ingested with the same input is skipped and changes nothing.
 */
export class IngestPipelineService {
  constructor(private readonly store: WorldStoreService) {}

  private entity(type: EntityType, id: string, name: string, runId: string, at: string, properties: Record<string, unknown>, confidence = 1): WMEntity {
    return {
      id,
      type,
      name,
      properties,
      provenance: { source: "pipeline", runId, agentId: "ingest", taskId: null, createdAt: at, updatedAt: at },
      lifecycle: { state: "active", confidence },
      aggregates: { mentionCount: 0, firstSeenAt: null, lastSeenAt: null },
    };
  }

  /** The edges this run should own, by id. */
  private desiredEdges(r: RunIngestInput): WMEdge[] {
    const edge = (type: EdgeType, from: string, to: string, properties: Record<string, unknown> = {}): WMEdge => ({
      id: ids.edge(type, from, to),
      type,
      from,
      to,
      directed: true,
      runId: r.runId,
      properties,
    });
    const out: WMEdge[] = [];
    const run = ids.run(r.runId);
    for (const s of r.sections) out.push(edge("part_of", ids.section(s.section_id), ids.act(s.act_id)));
    for (const d of r.definitions) out.push(edge("defines", ids.section(d.section_id), ids.definition(d.section_id, d.term), { term: d.term }));
    for (const c of r.claims) {
      const claim = ids.claim(r.runId, c.id);
      out.push(edge("produced", run, claim));
      for (const s of c.section_ids) out.push(edge("cites", claim, ids.section(s)));
    }
    for (const k of r.checked) {
      const claim = ids.claim(r.runId, k.claim.id);
      out.push(edge("judges", ids.verdict(r.runId, k.claim.id), claim, { verdict: k.verdict }));
      for (const s of k.claim.section_ids) out.push(edge("cites", claim, ids.section(s)));
      for (const d of k.definitions ?? []) out.push(edge("uses_definition", claim, ids.definition(d.section_id, d.term), { term: d.term }));
    }
    return out;
  }

  private stage(name: Stage, r: RunIngestInput): number {
    const s = this.store;
    const at = r.finishedAt;
    let n = 0;
    const count = (changed: boolean) => {
      if (changed) n++;
    };
    switch (name) {
      case "reconcile": {
        // detach edges this run owned before that it no longer produces (reprocessing a changed run)
        const keep = new Set(this.desiredEdges(r).map((e) => e.id));
        for (const e of Object.values(s.doc.edges)) if (e.runId === r.runId && !keep.has(e.id)) count(s.removeEdge(e.id));
        break;
      }
      case "classify": {
        // the run is a context and an entity; Acts are the top of the hierarchy
        const run = ids.run(r.runId);
        count(
          s.upsertContext({
            id: run,
            kind: "run",
            name: r.runId,
            properties: { finishedAt: at, claims: r.claims.length },
            provenance: { source: "pipeline", runId: r.runId, agentId: "ingest", taskId: null, createdAt: at, updatedAt: at },
          }),
        );
        count(s.upsertEntity(this.entity("run", run, r.runId, r.runId, at, { finishedAt: at })));
        for (const act of new Set(r.sections.map((x) => x.act_id))) {
          count(s.upsertEntity(this.entity("act", ids.act(act), r.actTitles?.[act] ?? act, r.runId, at, { act_id: act })));
        }
        break;
      }
      case "persist_primary": {
        for (const x of r.sections) {
          count(s.upsertEntity(this.entity("section", ids.section(x.section_id), x.section_id, r.runId, at, { section_id: x.section_id, act_id: x.act_id, section_no: x.section_no, heading: x.heading, text: x.text })));
        }
        for (const d of r.definitions) {
          count(s.upsertEntity(this.entity("definition", ids.definition(d.section_id, d.term), d.term, r.runId, at, { term: d.term, section_id: d.section_id, definition: d.definition })));
        }
        for (const c of r.claims) {
          count(s.upsertEntity(this.entity("claim", ids.claim(r.runId, c.id), c.id, r.runId, at, { claim_id: c.id, type: c.type ?? "obligation", text: c.text, section_ids: c.section_ids, agency: c.agency ?? null })));
        }
        break;
      }
      case "score": {
        for (const k of r.checked) {
          const base = CONFIDENCE[k.verdict] ?? 0;
          const id = ids.claim(r.runId, k.claim.id);
          const e = s.entity(id);
          if (e) count(s.patchEntity(id, { lifecycle: { ...e.lifecycle, confidence: k.quote_verified ? base : base * 0.5 } }));
        }
        break;
      }
      case "infer_derived": {
        for (const k of r.checked) {
          count(
            s.upsertEntity(
              this.entity("verdict", ids.verdict(r.runId, k.claim.id), `${k.claim.id}: ${k.verdict}`, r.runId, at, {
                claim_id: k.claim.id,
                verdict: k.verdict,
                reason: k.reason,
                quote: k.quote,
                quote_verified: k.quote_verified,
                qualifier: k.qualifier,
                section_ids: k.claim.section_ids,
              }, CONFIDENCE[k.verdict] ?? 0),
            ),
          );
        }
        break;
      }
      case "persist_edges": {
        for (const e of this.desiredEdges(r)) count(s.upsertEdge(e));
        break;
      }
      case "rebuild_views": {
        // materialised: facts by section, rebuilt from verdict -> claim -> section edges
        const view: Record<string, Array<{ runId: string; claimId: string; verdict: string }>> = {};
        for (const v of s.listEntities("verdict")) {
          for (const { entity: claim } of s.neighbors(v.id, { type: "judges", direction: "out" })) {
            for (const { entity: sec } of s.neighbors(claim.id, { type: "cites", direction: "out" })) {
              const key = String(sec.properties.section_id);
              (view[key] ??= []).push({ runId: v.provenance.runId, claimId: String(claim.properties.claim_id ?? claim.name), verdict: String(v.properties.verdict) });
            }
          }
        }
        for (const k of Object.keys(view)) view[k]!.sort((a, b) => a.runId.localeCompare(b.runId) || a.claimId.localeCompare(b.claimId));
        if (JSON.stringify(view) !== JSON.stringify(s.doc.views.factsBySection)) {
          s.doc.views.factsBySection = view;
          n++;
        }
        break;
      }
      case "patch_items": {
        // write computed fields back onto claims so consumers avoid the join
        for (const k of r.checked) count(s.patchEntity(ids.claim(r.runId, k.claim.id), { properties: { verdict: k.verdict } }));
        break;
      }
      case "rebuild_aggregates": {
        // recomputed from edges, never incremented: mentions = incoming cites / uses_definition edges
        const runAt = (runId: string) => String(s.doc.contexts[ids.run(runId)]?.properties.finishedAt ?? at);
        for (const e of s.listEntities()) {
          if (e.type !== "section" && e.type !== "definition") continue;
          const incoming = s.neighbors(e.id, { direction: "in" }).filter(({ edge }) => edge.type === "cites" || edge.type === "uses_definition");
          const times = incoming.map(({ edge }) => runAt(edge.runId)).sort();
          count(s.patchEntity(e.id, { aggregates: { mentionCount: incoming.length, firstSeenAt: times[0] ?? null, lastSeenAt: times.at(-1) ?? null } }));
        }
        break;
      }
      case "mark_stale": {
        // orphan detection: an entity with no edges at all is a data-quality alert
        for (const e of s.listEntities()) {
          const linked = s.neighbors(e.id).length > 0;
          const state = linked || e.type === "run" ? "active" : "orphan";
          if (e.lifecycle.state !== state) {
            count(s.patchEntity(e.id, { lifecycle: { ...e.lifecycle, state } }));
            if (state === "orphan") s.event({ type: "alert_orphan", id: e.id, entityType: e.type });
          }
        }
        break;
      }
    }
    return n;
  }

  /**
   * Ingests a finished run. `stopAfter` interrupts after a stage (for resumability tests); the next
   * call resumes from the following stage.
   */
  ingestRun(r: RunIngestInput, opts: { stopAfter?: Stage } = {}): IngestReport {
    const s = this.store;
    const inputHash = contentHash(r);
    const rec = s.doc.ingests[r.runId];
    if (rec?.completedAt && rec.inputHash === inputHash) {
      s.event({ type: "ingest_skipped", runId: r.runId, reason: "already ingested with the same input" });
      return { runId: r.runId, skipped: true, resumedFrom: null, stagesRun: [], changes: 0 };
    }
    // same input and unfinished: resume after the last completed stage; changed input: start over
    const done = rec && rec.inputHash === inputHash ? rec.stages : [];
    s.doc.ingests[r.runId] = { inputHash, stages: [...done], completedAt: null };
    const resumedFrom = done.length ? (STAGES[done.length] ?? null) : null;
    const stagesRun: Stage[] = [];
    let changes = 0;
    for (const stage of STAGES) {
      if (done.includes(stage)) continue;
      const n = this.stage(stage, r);
      changes += n;
      stagesRun.push(stage);
      s.doc.ingests[r.runId]!.stages.push(stage);
      s.commit(); // checkpoint after each stage
      s.event({ type: "stage_completed", runId: r.runId, stage, changes: n });
      if (opts.stopAfter === stage) return { runId: r.runId, skipped: false, resumedFrom, stagesRun, changes };
    }
    s.doc.ingests[r.runId]!.completedAt = r.finishedAt;
    s.commit();
    s.event({ type: "run_record", runId: r.runId, finishedAt: r.finishedAt, changes, claims: r.claims.length, checked: r.checked.length });
    s.event({ type: "health", ...s.health() });
    return { runId: r.runId, skipped: false, resumedFrom, stagesRun, changes };
  }
}
