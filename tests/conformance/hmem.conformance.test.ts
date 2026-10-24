// H-MEM conformance suite. NOTICE: no vendored suite exists; these tests are derived from the
// "Implementation Checklist" (section 17) of "Meterless H-MEM Agent Engine" v1.0
// (meterless-h-mem-agent-engine.md, provided to Open Agent Hackathon participants), one test per item
// that applies to the minimum build (MemoryStoreService + MemoryRetrievalService + TrustLedgerService,
// with no-model mining). Items outside the minimum build are listed in scripts/conformance.ts.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HMem, mineEvent, parseMemoryStrings, type RuntimeEvent } from "../../src/engines/hmem/index.js";

const dirs = () => {
  const d = mkdtempSync(join(tmpdir(), "hmem-conf-"));
  return { dataDir: join(d, "data"), logDir: join(d, "logs") };
};

describe("H-MEM conformance", () => {
  it("Define canonical memory schema with lineage and agent attribution fields.", () => {
    const h = new HMem(dirs());
    const m = h.store.add({ content: "x", type: "factual", layer: "working", source: "tool:run_sql", agentId: "researcher", runId: "run-1", taskId: "turn-3", derivedFrom: ["mem_a"], supersedes: "mem_b" });
    const lineage = ["supersedes", "derivedFrom", "relatedTo", "source"];
    const attribution = ["agentId", "runId", "taskId"];
    for (const k of [...lineage, ...attribution, "id", "content", "type", "layer", "timestamp", "lastAccessed", "accessCount", "tags", "embedding", "score", "confidence", "domain", "namespace", "entities"]) {
      expect(m, k).toHaveProperty(k);
    }
    expect(m).toMatchObject({ agentId: "researcher", runId: "run-1", taskId: "turn-3", derivedFrom: ["mem_a"], supersedes: "mem_b" });
  });

  it("Implement tiered persistence and warm-start loading.", () => {
    const d = dirs();
    const a = new HMem(d);
    a.startRun("r1");
    const w = a.store.add({ content: "working fact", type: "factual", layer: "working", source: "s", agentId: "a", runId: "r1" });
    const l = a.store.add({ content: "long fact", type: "factual", layer: "long_term", source: "s", agentId: "a", runId: "r1" });
    const s = a.store.add({ content: "short note", type: "general", layer: "short_term", source: "s", agentId: "a", runId: "r1" });
    expect(existsSync(join(d.dataDir, "working.json")) && existsSync(join(d.dataDir, "long_term.json"))).toBe(true);
    a.endRun("r1");
    const b = new HMem(d);
    b.startRun("r2"); // warm start: a fresh process resumes with prior knowledge
    expect([b.store.get(w.id)?.layer, b.store.get(l.id)?.layer, b.store.get(s.id)?.layer]).toEqual(["working", "long_term", "short_term"]);
    expect(b.ledger.query({ action: "hydrate", runId: "r2" })).toHaveLength(1);
  });

  it("Add acquisition hooks for all runtime event types (tool result, handoff, node-complete, verdict, outcome).", () => {
    const events: RuntimeEvent[] = [
      { kind: "tool_result", agentId: "researcher", runId: "r", tool: "get_sections", label: "s22", rowCount: 1, sectionIds: ["NTAA-2025-s22"] },
      { kind: "handoff", agentId: "researcher", runId: "r", to: "critic", summary: "2 claims" },
      { kind: "node_complete", agentId: "researcher", runId: "r", node: "research", summary: "2 claims" },
      { kind: "verdict", agentId: "critic", runId: "r", claimId: "c1", claimText: "t", verdict: "struck", sectionIds: ["NTA-2025-s147"], quote: null, quoteVerified: false, reason: "r" },
      { kind: "outcome", agentId: "pipeline", runId: "r", success: true, summary: "done" },
    ];
    const h = new HMem(dirs());
    for (const e of events) {
      const [m] = h.observe(e);
      expect(m, e.kind).toMatchObject({ layer: "short_term", agentId: e.agentId, runId: "r" });
      expect(m?.tags, e.kind).toContain(e.kind);
    }
  });

  it("Build extraction prompts + robust JSON parsing fallback (no-model path). [robust parsing and no-model path; no extraction model is used]", () => {
    expect(parseMemoryStrings("noise ```json\n[\"VAT is 7.5%\", {\"content\": \"returns by the 21st\"}]\n``` noise")).toEqual(["VAT is 7.5%", "returns by the 21st"]);
    expect(parseMemoryStrings("{not an array}")).toEqual([]);
    const e: RuntimeEvent = { kind: "outcome", agentId: "pipeline", runId: "r", success: false, summary: "gateway 502" };
    expect(mineEvent(e, "garbled model output").map((m) => m.content)).toEqual(["Run outcome (failure): gateway 502"]); // falls back to direct capture
    expect(mineEvent(e, '["approach X failed"]').map((m) => m.content)).toEqual(["approach X failed"]);
  });

  it("Implement enrichment (domain, namespace, entities, relations).", () => {
    const h = new HMem(dirs());
    const a = h.store.add({ content: "get_sections NTAA-2025-s22 returned 1 rows", type: "factual", layer: "working", source: "tool:get_sections", agentId: "a", runId: "r" });
    const b = h.store.add({ content: "Critic judged c1 (NTAA-2025-s22) supported", type: "factual", layer: "working", source: "critic:verdict", agentId: "critic", runId: "r" });
    expect(a).toMatchObject({ domain: "tooling", namespace: "tooling/get_sections" });
    expect(b.domain).toBe("verification");
    expect(b.entities).toEqual(expect.arrayContaining(["NTAA-2025-s22", "NTAA-2025"]));
    expect(b.relatedTo).toContain(a.id); // shared entity
  });

  it("Implement hybrid retrieval scoring + structured reinjection payload + trace metadata.", () => {
    const h = new HMem(dirs());
    h.startRun("r");
    h.store.add({ content: "VAT returns are due on the 21st", type: "factual", layer: "working", source: "s", agentId: "a", runId: "r" });
    const pkg = h.retrieval.retrieve("when are VAT returns due", { runId: "r", agentId: "researcher" });
    expect(pkg).toMatchObject({ schema: "hmem.context.v1", strategy: "task_focused", runId: "r" });
    expect(typeof pkg.retrievalReason).toBe("string");
    const m = pkg.memories[0]!;
    expect(Object.keys(m.components).sort()).toEqual(["access", "keyword", "layer", "recency", "retention", "similarity"]);
    expect(m.score).toBeGreaterThan(0);
    expect(m.why.length).toBeGreaterThan(0);
  });

  it("Implement trust ledger as queryable JSONL audit, shippable to logs/.", () => {
    const d = dirs();
    const h = new HMem(d);
    const [m] = h.observe({ kind: "outcome", agentId: "pipeline", runId: "r", success: true, summary: "ok" });
    h.retrieval.retrieve("run outcome success ok", { runId: "r", agentId: "researcher" });
    const raw = readFileSync(join(d.logDir, "ledger.jsonl"), "utf-8").trim().split("\n");
    expect(raw.every((l) => typeof JSON.parse(l).action === "string")).toBe(true);
    expect(h.ledger.query({ memoryId: m!.id }).map((e) => e.action)).toEqual(["create", "read"]);
    expect(h.ledger.export({ runId: "r" })).toContain(m!.id);
    expect(h.ledger.stats().create).toBeGreaterThanOrEqual(1);
  });
});
