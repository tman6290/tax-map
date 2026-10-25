// World Model store: one JSON document written through on every commit, with a JSONL event log.
// A failed disk write leaves the store working in memory, marked degraded.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stableStringify } from "./ids.js";
import { SCHEMA_VERSION, type EdgeType, type EntityType, type WMContext, type WMEdge, type WMEntity, type WorldDoc } from "./types.js";

const emptyDoc = (): WorldDoc => ({ schemaVersion: SCHEMA_VERSION, entities: {}, contexts: {}, edges: {}, ingests: {}, views: { factsBySection: {} } });

/**
 * Canonical reconstruction (World Model spec §11.2) when two writers touch the same record: strings
 * keep the longest (most informative) text, arrays are unioned, other values are latest-wins.
 */
function mergeProps(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const old = out[k];
    if (v === undefined) continue;
    if (typeof v === "string" && typeof old === "string") out[k] = v.length >= old.length ? v : old;
    else if (Array.isArray(v) && Array.isArray(old)) out[k] = [...new Set([...old, ...v].map((x) => stableStringify(x)))].map((x) => JSON.parse(x));
    else out[k] = v;
  }
  return out;
}

export interface StoreHealth {
  schemaVersion: number;
  entities: Record<EntityType, number>;
  edges: number;
  contexts: number;
  orphans: number;
  runsIngested: number;
  degraded: boolean;
}

/**
 * WorldStoreService (World Model spec §5): one write-through adapter over a JSON document in `dir`.
 * Every commit writes the whole aggregate document (not deltas), and every change is appended to the
 * JSONL event log. If the disk write fails the store keeps working in memory, marked degraded, and
 * logs the failure as an event.
 */
export class WorldStoreService {
  doc: WorldDoc;
  degraded = false;
  private readonly file: string;

  constructor(
    dir: string,
    private readonly eventLog: string,
  ) {
    this.file = join(dir, "world.json");
    this.doc = emptyDoc();
    if (existsSync(this.file)) {
      try {
        const loaded = JSON.parse(readFileSync(this.file, "utf-8")) as WorldDoc;
        this.doc = loaded.schemaVersion === SCHEMA_VERSION ? { ...emptyDoc(), ...loaded } : emptyDoc();
      } catch {
        this.event({ type: "load_failed", file: this.file });
      }
    }
  }

  event(e: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.eventLog), { recursive: true });
      appendFileSync(this.eventLog, `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`, "utf-8");
    } catch {
      // the event log is evidence, not state: losing a line must not stop the store
    }
  }

  /** Write-through of the aggregate document; falls back to memory (degraded) on failure. */
  commit(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.doc), "utf-8");
      this.degraded = false;
    } catch (err) {
      this.degraded = true;
      this.event({ type: "persist_failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Upserts an entity with canonical reconstruction; returns whether anything changed. */
  upsertEntity(e: WMEntity): boolean {
    const old = this.doc.entities[e.id];
    const next: WMEntity = old
      ? {
          ...old,
          name: e.name.length >= old.name.length ? e.name : old.name,
          properties: mergeProps(old.properties, e.properties),
          provenance: { ...old.provenance, updatedAt: e.provenance.updatedAt > old.provenance.updatedAt ? e.provenance.updatedAt : old.provenance.updatedAt },
          lifecycle: { ...old.lifecycle, confidence: e.lifecycle.confidence },
        }
      : e;
    if (old && stableStringify(old) === stableStringify(next)) return false;
    this.doc.entities[e.id] = next;
    this.event({ type: old ? "entity_updated" : "entity_created", id: e.id, entityType: e.type, runId: e.provenance.runId });
    return true;
  }

  upsertContext(c: WMContext): boolean {
    const old = this.doc.contexts[c.id];
    const next = old ? { ...old, properties: mergeProps(old.properties, c.properties) } : c;
    if (old && stableStringify(old) === stableStringify(next)) return false;
    this.doc.contexts[c.id] = next;
    this.event({ type: old ? "context_updated" : "context_created", id: c.id, runId: c.provenance.runId });
    return true;
  }

  upsertEdge(e: WMEdge): boolean {
    const old = this.doc.edges[e.id];
    const next = old ? { ...old, properties: mergeProps(old.properties, e.properties) } : e;
    if (old && stableStringify(old) === stableStringify(next)) return false;
    this.doc.edges[e.id] = next;
    if (!old) this.event({ type: "edge_created", id: e.id, edgeType: e.type, from: e.from, to: e.to, runId: e.runId });
    return true;
  }

  removeEdge(id: string): boolean {
    if (!this.doc.edges[id]) return false;
    delete this.doc.edges[id];
    this.event({ type: "edge_removed", id });
    return true;
  }

  /** Patches mutable annotations (aggregates, lifecycle state) without touching provenance. */
  patchEntity(id: string, patch: Partial<Pick<WMEntity, "aggregates" | "lifecycle" | "properties">>): boolean {
    const old = this.doc.entities[id];
    if (!old) return false;
    const next: WMEntity = {
      ...old,
      ...(patch.aggregates ? { aggregates: patch.aggregates } : {}),
      ...(patch.lifecycle ? { lifecycle: patch.lifecycle } : {}),
      ...(patch.properties ? { properties: { ...old.properties, ...patch.properties } } : {}),
    };
    if (stableStringify(old) === stableStringify(next)) return false;
    this.doc.entities[id] = next;
    return true;
  }

  entity(id: string): WMEntity | undefined {
    return this.doc.entities[id];
  }

  listEntities(type?: EntityType): WMEntity[] {
    return Object.values(this.doc.entities).filter((e) => !type || e.type === type);
  }

  /** Graph query (World Model spec §8): edges and neighbour entities of `id`. */
  neighbors(id: string, opts: { type?: EdgeType; direction?: "out" | "in" | "both" } = {}): Array<{ edge: WMEdge; entity: WMEntity }> {
    const dir = opts.direction ?? "both";
    const out: Array<{ edge: WMEdge; entity: WMEntity }> = [];
    for (const e of Object.values(this.doc.edges)) {
      if (opts.type && e.type !== opts.type) continue;
      const other = e.from === id && dir !== "in" ? e.to : e.to === id && dir !== "out" ? e.from : undefined;
      const entity = other ? this.doc.entities[other] : undefined;
      if (entity) out.push({ edge: e, entity });
    }
    return out;
  }

  health(): StoreHealth {
    const entities: Record<EntityType, number> = { act: 0, section: 0, definition: 0, claim: 0, verdict: 0, run: 0 };
    let orphans = 0;
    for (const e of Object.values(this.doc.entities)) {
      entities[e.type]++;
      if (e.lifecycle.state === "orphan") orphans++;
    }
    return {
      schemaVersion: this.doc.schemaVersion,
      entities,
      edges: Object.keys(this.doc.edges).length,
      contexts: Object.keys(this.doc.contexts).length,
      orphans,
      runsIngested: Object.values(this.doc.ingests).filter((i) => i.completedAt).length,
      degraded: this.degraded,
    };
  }
}
