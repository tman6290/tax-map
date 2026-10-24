// World Model conformance suite. NOTICE: no vendored suite exists; these tests are derived from the
// "Implementation Checklist" (section 18) of "Meterless World Model Agent Engine"
// (meterless-world-model-agent-engine.md, provided to Open Agent Hackathon participants), one test per
// item that applies to the minimum build (WorldStoreService + IngestPipelineService +
// ContextBuilderService). Items outside the minimum build are listed in scripts/conformance.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ids, stableStringify, STAGES, WorldModelEngine } from "../../src/engines/world_model/index.js";
import { runInput, worldDirs } from "../fixtures/world.js";

const AT = "2026-10-24T10:00:00.000Z";

describe("World Model conformance", () => {
  it("Pick aggregate shape (timeline / stream-cluster / graph / hybrid).", () => {
    const wm = new WorldModelEngine(worldDirs());
    wm.ingestRun(runInput("run-1", AT));
    const doc = wm.store.doc;
    // graph aggregate: typed nodes, typed directed edges, runs as contexts
    expect(Object.keys(doc).sort()).toEqual(["contexts", "edges", "entities", "ingests", "schemaVersion", "views"]);
    expect(new Set(Object.values(doc.edges).map((e) => e.type))).toEqual(new Set(["part_of", "defines", "produced", "cites", "judges", "uses_definition"]));
    expect(Object.values(doc.contexts).map((c) => c.kind)).toEqual(["run"]);
  });

  it("Define entity / context / relationship records with provenance, lifecycle and agent attribution.", () => {
    const wm = new WorldModelEngine(worldDirs());
    wm.ingestRun(runInput("run-1", AT));
    const e = wm.store.entity(ids.claim("run-1", "c1"))!;
    expect(Object.keys(e.provenance).sort()).toEqual(["agentId", "createdAt", "runId", "source", "taskId", "updatedAt"]);
    expect(e.lifecycle).toMatchObject({ state: "active" });
    expect(typeof e.lifecycle.confidence).toBe("number");
    const ctx = Object.values(wm.store.doc.contexts)[0]!;
    expect(ctx.provenance.runId).toBe("run-1");
    const edge = Object.values(wm.store.doc.edges)[0]!;
    expect(edge).toMatchObject({ directed: true, runId: "run-1" });
  });

  it("Choose a substrate; implement the write-through adapter with graceful fallback.", () => {
    const dirs = worldDirs();
    new WorldModelEngine(dirs).ingestRun(runInput("run-1", AT));
    const reloaded = new WorldModelEngine(dirs);
    expect(reloaded.store.health().runsIngested).toBe(1); // written through to disk
    writeFileSync(join(dirs.dataDir, "..", "not-a-dir"), "x");
    const failing = new WorldModelEngine({ dataDir: join(dirs.dataDir, "..", "not-a-dir"), logDir: dirs.logDir });
    failing.ingestRun(runInput("run-1", AT));
    expect(failing.store.degraded).toBe(true);
    expect(failing.verifiedFacts("run-1").length).toBe(1); // degraded, still serving from memory
  });

  it("Implement content-hash stable ID derivation.", () => {
    expect(ids.section("NTAA-2025-s22")).toBe(ids.section("NTAA-2025-s22"));
    expect(ids.section("NTAA-2025-s22")).not.toBe(ids.section("NTAA-2025-s23"));
    expect(ids.definition("NTAA-2025-s147", "Small Business")).toBe(ids.definition("NTAA-2025-s147", "small business"));
    const a = new WorldModelEngine(worldDirs());
    const b = new WorldModelEngine(worldDirs());
    a.ingestRun(runInput("run-1", AT));
    b.ingestRun(runInput("run-1", AT));
    expect(Object.keys(a.store.doc.entities).sort()).toEqual(Object.keys(b.store.doc.entities).sort()); // independent writers converge
  });

  it("Implement the 10-step canonical ingest pipeline (idempotent, resumable, interrupt-safe).", () => {
    expect(STAGES).toHaveLength(10);
    const dirs = worldDirs();
    const wm = new WorldModelEngine(dirs);
    wm.ingestRun(runInput("run-1", AT), { stopAfter: "score" }); // interrupted
    const resumed = new WorldModelEngine(dirs).ingestRun(runInput("run-1", AT));
    expect(resumed.resumedFrom).toBe("infer_derived");
    const done = new WorldModelEngine(dirs);
    const before = stableStringify(done.store.doc);
    expect(done.ingestRun(runInput("run-1", AT))).toMatchObject({ skipped: true, changes: 0 });
    expect(stableStringify(done.store.doc)).toBe(before);
  });

  it("Implement relationship maturity ladder (implicit → typed) + graph queries. [typed edges and graph queries]", () => {
    const wm = new WorldModelEngine(worldDirs());
    wm.ingestRun(runInput("run-1", AT));
    wm.ingestRun(runInput("run-2", "2026-10-25T10:00:00.000Z"));
    const sec = ids.section("NTAA-2025-s22");
    const citing = wm.store.neighbors(sec, { type: "cites", direction: "in" });
    expect(citing.map((n) => n.entity.provenance.runId).sort()).toEqual(["run-1", "run-2"]);
    expect(wm.store.neighbors(sec, { type: "part_of", direction: "out" })[0]?.entity.name).toBe("NTAA-2025");
  });

  it("Implement the context-builder returning a structured payload + trace metadata + wired-vs-helper manifest.", () => {
    const wm = new WorldModelEngine(worldDirs());
    wm.ingestRun(runInput("run-1", AT));
    const ctx = wm.context.buildForClaim("run-1", "c1");
    expect(ctx.schema).toMatch(/^wm\.claim_context\.v\d+$/);
    expect(ctx.sections[0]?.text).toContain("shall not apply to a small business");
    expect(ctx.trace).toMatchObject({ strategy: "claim_focused" });
    expect(ctx.trace.selectionReason.length).toBeGreaterThan(0);
    expect(ctx.manifest.wired.length + ctx.manifest.dormant.length).toBeGreaterThan(0);
  });

  it("Ship append log, run records, enrichment status, and health as JSONL to logs/. [append log, run records and health; no enrichment jobs]", () => {
    const dirs = worldDirs();
    new WorldModelEngine(dirs).ingestRun(runInput("run-1", AT));
    const events = readFileSync(join(dirs.logDir, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const types = new Set(events.map((e) => e.type));
    for (const t of ["entity_created", "edge_created", "stage_completed", "run_record", "health"]) expect(types, t).toContain(t);
    expect(events.every((e) => typeof e.ts === "string")).toBe(true);
  });
});
