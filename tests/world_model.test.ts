import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTEXT_SCHEMA, ids, stableStringify, STAGES, WorldModelEngine } from "../src/engines/world_model/index.js";
import { runInput, S22, worldDirs } from "./fixtures/world.js";

const fact = (claim_id: string, verdict: "supported" | "struck") => ({
  section_id: "NTAA-2025-s22",
  act_id: "NTAA-2025",
  section_no: "22",
  heading: "Returns for value added tax",
  text: S22,
  source: "taxmap.sections",
  verdict,
  claim_id,
  reason: "r",
  quote: "shall not apply to a small business",
  ts: "2026-10-24T10:00:00.000Z",
});

describe("WorldStoreService", () => {
  it("ingests acts, sections, definitions, claims, verdicts and the run, with typed edges", () => {
    const wm = new WorldModelEngine(worldDirs());
    wm.ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z"));
    const h = wm.store.health();
    expect(h.entities).toMatchObject({ act: 2, section: 2, definition: 1, claim: 2, verdict: 2, run: 1 });
    const claim = ids.claim("run-1", "c1");
    expect(wm.store.neighbors(claim, { type: "cites", direction: "out" }).map((n) => n.entity.name)).toEqual(["NTAA-2025-s22"]);
    expect(wm.store.neighbors(claim, { type: "uses_definition", direction: "out" }).map((n) => n.entity.name)).toEqual(["small business"]);
    expect(wm.store.neighbors(claim, { type: "judges", direction: "in" }).map((n) => n.entity.properties.verdict)).toEqual(["supported"]);
    expect(wm.store.neighbors(ids.run("run-1"), { type: "produced", direction: "out" })).toHaveLength(2);
    expect(wm.store.entity(ids.section("NTAA-2025-s22"))?.aggregates.mentionCount).toBe(1);
  });

  it("is write-through: a new engine on the same directory sees the same world, and the event log is JSONL", () => {
    const dirs = worldDirs();
    const a = new WorldModelEngine(dirs);
    a.ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z"));
    const b = new WorldModelEngine(dirs);
    expect(stableStringify(b.store.doc)).toBe(stableStringify(a.store.doc));
    const events = readFileSync(join(dirs.logDir, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "run_record" && e.runId === "run-1")).toBe(true);
    expect(events.some((e) => e.type === "health")).toBe(true);
  });

  it("falls back to memory, marked degraded, when the store cannot be written", () => {
    const dirs = worldDirs();
    // a file where the data directory should be makes every write fail
    writeFileSync(join(dirs.dataDir, "..", "blocker"), "x");
    const wm = new WorldModelEngine({ dataDir: join(dirs.dataDir, "..", "blocker"), logDir: dirs.logDir });
    wm.ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z"));
    expect(wm.store.degraded).toBe(true);
    expect(wm.facts().length).toBeGreaterThan(0); // still answers from memory
    expect(readFileSync(join(dirs.logDir, "events.jsonl"), "utf-8")).toContain("persist_failed");
  });
});

describe("IngestPipelineService", () => {
  it("is idempotent: re-ingesting the same run changes nothing", () => {
    const wm = new WorldModelEngine(worldDirs());
    const first = wm.ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z"));
    expect(first.changes).toBeGreaterThan(0);
    const before = stableStringify(wm.store.doc);
    const again = wm.ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z"));
    expect(again).toMatchObject({ skipped: true, changes: 0 });
    expect(stableStringify(wm.store.doc)).toBe(before);
  });

  it("is resumable: an interrupted ingest continues from the next stage and ends in the same state", () => {
    const full = new WorldModelEngine(worldDirs());
    full.ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z"));

    const dirs = worldDirs();
    const part = new WorldModelEngine(dirs);
    const cut = part.ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z"), { stopAfter: "persist_primary" });
    expect(cut.stagesRun).toEqual(["reconcile", "classify", "persist_primary"]);
    // a new process picks up the checkpoint
    const resumed = new WorldModelEngine(dirs).ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z"));
    expect(resumed.resumedFrom).toBe("score");
    expect(resumed.stagesRun).toEqual(STAGES.slice(3));
    const strip = (doc: unknown) => stableStringify({ ...(doc as object), ingests: {} });
    expect(strip(new WorldModelEngine(dirs).store.doc)).toBe(strip(full.store.doc));
  });

  it("reconciles a changed run: edges for a dropped claim are detached", () => {
    const wm = new WorldModelEngine(worldDirs());
    wm.ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z"));
    const changed = runInput("run-1", "2026-10-24T10:00:00.000Z");
    changed.claims = changed.claims.slice(0, 1);
    changed.checked = changed.checked.slice(0, 1);
    wm.ingestRun(changed);
    expect(wm.store.neighbors(ids.claim("run-1", "c2"))).toHaveLength(0);
    expect(wm.store.entity(ids.claim("run-1", "c2"))?.lifecycle.state).toBe("orphan");
  });

  it("uses content-hash ids, so the same section from two runs is one entity", () => {
    const wm = new WorldModelEngine(worldDirs());
    wm.ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z"));
    wm.ingestRun(runInput("run-2", "2026-10-25T10:00:00.000Z"));
    expect(wm.store.listEntities("section")).toHaveLength(2);
    expect(wm.store.listEntities("claim")).toHaveLength(4);
    expect(wm.store.entity(ids.section("NTAA-2025-s22"))?.aggregates).toMatchObject({ mentionCount: 2, firstSeenAt: "2026-10-24T10:00:00.000Z", lastSeenAt: "2026-10-25T10:00:00.000Z" });
  });
});

describe("ContextBuilderService", () => {
  it("returns a claim's sections verbatim, its definitions and earlier runs' verdicts on the same section, with a trace", () => {
    const wm = new WorldModelEngine(worldDirs());
    wm.ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z", "qualified"));
    wm.ingestRun(runInput("run-2", "2026-10-25T10:00:00.000Z"));
    const ctx = wm.context.buildForClaim("run-2", "c1");
    expect(ctx.schema).toBe(CONTEXT_SCHEMA);
    expect(ctx.claim).toMatchObject({ claimId: "c1", verdict: "supported", type: "exemption" });
    expect(ctx.sections).toEqual([{ section_id: "NTAA-2025-s22", heading: "Returns for value added tax", text: S22, mentionCount: 2 }]);
    expect(ctx.definitions.map((d) => d.term)).toEqual(["small business"]);
    expect(ctx.priorVerdicts).toEqual([expect.objectContaining({ runId: "run-1", claimId: "c1", verdict: "qualified", section_id: "NTAA-2025-s22" })]);
    expect(ctx.trace.joined.length).toBeGreaterThanOrEqual(4);
    expect(ctx.manifest.wired.length).toBeGreaterThan(0);
    expect(wm.context.buildForClaim("run-2", "nope").claim).toBeNull();
  });
});

describe("WorldModel interface", () => {
  it("the Critic's addFact writes through, getFacts reads back, and the later ingest leaves those facts consistent", async () => {
    const wm = new WorldModelEngine(worldDirs());
    const forRun = wm.forRun("run-1");
    await forRun.addFact(fact("c1", "supported"));
    expect(await forRun.getFacts({ verdict: "supported" })).toEqual([expect.objectContaining({ claim_id: "c1", section_id: "NTAA-2025-s22", run_id: "run-1" })]);
    wm.ingestRun(runInput("run-1", "2026-10-24T10:00:00.000Z"));
    expect(wm.verifiedFacts("run-1").map((f) => `${f.claim_id}:${f.section_id}`)).toEqual(["c1:NTAA-2025-s22"]);
    expect(wm.store.entity(ids.claim("run-1", "c1"))?.properties.text).toMatch(/small business/); // filled in by the ingest
    expect(wm.stats("run-1")).toMatchObject({ verified_facts_this_run: 1, facts_this_run: 2, runs_ingested: 1 });
  });
});
