import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { research } from "../src/agents/researcher.js";
import type { Profile } from "../src/agents/types.js";
import { runSql } from "../src/data/zetaris.js";
import { cosine, embed, EMBEDDING_DIM, HMem, parseMemoryStrings, retention, type MemoryRecord } from "../src/engines/hmem/index.js";
import { chat, type ChatOptions } from "../src/providers/meterless.js";

vi.mock("../src/providers/meterless.js", () => ({ chat: vi.fn() }));
vi.mock("../src/data/zetaris.js", () => ({ runSql: vi.fn() }));

const T0 = new Date("2026-10-24T09:00:00.000Z");
let clock = T0;
const now = () => clock;
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

function freshDirs() {
  const dir = mkdtempSync(join(tmpdir(), "hmem-test-"));
  return { dataDir: join(dir, "data"), logDir: join(dir, "logs") };
}

const toolEntry = (sql: string, sections: Array<[string, string]>) => ({
  kind: "tool_result",
  tags: ["run_sql"],
  content: { tool: "run_sql", label: sql, row_count: sections.length, sections: sections.map(([section_id, heading]) => ({ section_id, heading, snippet: "" })) },
});

beforeEach(() => {
  clock = T0;
});

describe("embedding", () => {
  it("is deterministic, fixed-dimension and unit length, with cosine similarity", () => {
    const a = embed("value added tax return small business");
    expect(a).toHaveLength(EMBEDDING_DIM);
    expect(embed("value added tax return small business")).toEqual(a);
    expect(Math.sqrt(a.reduce((n, x) => n + x * x, 0))).toBeCloseTo(1, 6);
    expect(cosine(a, embed("small business VAT return"))).toBeGreaterThan(cosine(a, embed("petroleum royalty oil")));
  });
});

describe("MemoryStoreService", () => {
  it("writes the canonical record with lineage and attribution, persists working and long-term, and warm-starts", () => {
    const dirs = freshDirs();
    const h = new HMem({ ...dirs, now });
    h.startRun("run-1");
    const m = h.store.add({ content: "NTAA-2025-s22 disapplies VAT returns for small businesses", type: "factual", layer: "long_term", source: "critic:verified", agentId: "critic", runId: "run-1", tags: ["verified"] });
    for (const k of ["id", "content", "type", "layer", "timestamp", "lastAccessed", "accessCount", "tags", "embedding", "score", "confidence", "source", "domain", "namespace", "entities", "relatedTo", "supersedes", "derivedFrom", "agentId", "runId", "taskId"]) {
      expect(m).toHaveProperty(k);
    }
    expect(m.entities).toEqual(expect.arrayContaining(["NTAA-2025-s22", "NTAA-2025"]));
    expect(m.domain).toBe("verification");

    const again = new HMem({ ...dirs, now });
    again.startRun("run-2");
    expect(again.store.get(m.id)?.content).toBe(m.content);
  });

  it("backfills missing embeddings at load", () => {
    const dirs = freshDirs();
    const h = new HMem({ ...dirs, now });
    h.startRun("r");
    const m = h.store.add({ content: "books of account must be kept", type: "factual", layer: "working", source: "tool:get_sections", agentId: "a", runId: "r" });
    const file = join(dirs.dataDir, "working.json");
    const rows = JSON.parse(readFileSync(file, "utf-8")) as MemoryRecord[];
    writeFileSync(file, JSON.stringify(rows.map((r) => ({ ...r, embedding: [] }))));
    const loaded = new HMem({ ...dirs, now });
    loaded.startRun("r2");
    expect(loaded.store.get(m.id)?.embedding).toHaveLength(EMBEDDING_DIM);
  });

  it("applies the forgetting curve to non-long-term records and forgets the faded ones", () => {
    expect(retention("long_term", T0.toISOString(), hours(10_000))).toBe(1);
    expect(retention("working", T0.toISOString(), hours(168))).toBeCloseTo(Math.exp(-1), 6);
    const dirs = freshDirs();
    const h = new HMem({ ...dirs, now });
    h.startRun("r");
    const w = h.store.add({ content: "working memory", type: "general", layer: "working", source: "s", agentId: "a", runId: "r" });
    const s = h.store.add({ content: "short memory", type: "general", layer: "short_term", source: "s", agentId: "a", runId: "r" });
    const l = h.store.add({ content: "long memory", type: "factual", layer: "long_term", source: "s", agentId: "a", runId: "r" });
    h.endRun("r");
    clock = hours(96); // 4 days later
    const later = new HMem({ ...dirs, now });
    later.startRun("r2");
    expect(later.store.get(w.id)?.score).toBeCloseTo(Math.exp(-96 / 168), 4);
    expect(later.store.get(s.id)).toBeUndefined(); // exp(-96/24) < 0.05: forgotten
    expect(later.store.get(l.id)?.score).toBe(1);
    expect(later.ledger.query({ memoryId: s.id, action: "forget" })).toHaveLength(1);
  });
});

describe("MemoryRetrievalService", () => {
  it("ranks by similarity, recency and access, returns a structured package with trace metadata, and records the access", () => {
    const h = new HMem({ ...freshDirs(), now });
    h.startRun("r");
    const vat = h.store.add({ content: "VAT returns are due by the 21st of the following month", type: "factual", layer: "working", source: "tool:get_sections", agentId: "a", runId: "r" });
    h.store.add({ content: "petroleum royalty is payable on crude oil", type: "factual", layer: "working", source: "tool:get_sections", agentId: "a", runId: "r" });
    const pkg = h.retrieval.retrieve("when are VAT returns due", { runId: "r", agentId: "researcher" });
    expect(pkg.schema).toBe("hmem.context.v1");
    expect(pkg.memories[0]?.id).toBe(vat.id);
    expect(pkg.memories.every((m) => m.content !== "petroleum royalty is payable on crude oil")).toBe(true); // below threshold
    expect(pkg.memories[0]?.components.similarity).toBeGreaterThan(0.3);
    expect(pkg.retrievalReason).toMatch(/hybrid score/);
    expect(pkg.memories[0]?.why).toMatch(/similarity/);
    expect(h.store.get(vat.id)?.accessCount).toBe(1);
    expect(h.ledger.query({ memoryId: vat.id, action: "read" })).toHaveLength(1);
  });

  it("weights long-term above working above short-term for equal content", () => {
    const h = new HMem({ ...freshDirs(), now });
    h.startRun("r");
    const s = h.store.add({ content: "keep books of account", type: "factual", layer: "short_term", source: "x", agentId: "a", runId: "r" });
    const l = h.store.add({ content: "keep books of account", type: "factual", layer: "long_term", source: "x", agentId: "a", runId: "r" });
    const { ranked } = h.retrieval.rank("books of account", { runId: "r", agentId: "a" });
    expect(ranked.findIndex((m) => m.id === l.id)).toBeLessThan(ranked.findIndex((m) => m.id === s.id));
  });
});

describe("promotion and mining", () => {
  it("promotes a short-term memory retrieved in two different runs to working", () => {
    const dirs = freshDirs();
    const one = new HMem({ ...dirs, now });
    const [m] = one.observe({ kind: "tool_result", agentId: "researcher", runId: "run-1", tool: "get_sections", label: "VAT returns", rowCount: 1, sectionIds: ["NTAA-2025-s22"], headings: ["Returns for value added tax"] });
    one.retrieval.retrieve("VAT returns for value added tax", { runId: "run-1", agentId: "researcher" });
    expect(one.store.get(m!.id)?.layer).toBe("short_term");
    one.endRun("run-1");

    clock = hours(1);
    const two = new HMem({ ...dirs, now });
    two.startRun("run-2");
    const pkg = two.retrieval.retrieve("VAT returns for value added tax", { runId: "run-2", agentId: "researcher" });
    expect(pkg.memories[0]).toMatchObject({ id: m!.id, fromEarlierRun: true });
    expect(two.store.get(m!.id)?.layer).toBe("working");
    expect(two.ledger.query({ memoryId: m!.id, action: "promote" })).toHaveLength(1);
  });

  it("writes a Critic-verified fact as long-term factual memory derived from the tool results that surfaced it", () => {
    const h = new HMem({ ...freshDirs(), now });
    const [tool] = h.observe({ kind: "tool_result", agentId: "researcher", runId: "r", tool: "get_sections", label: "s22", rowCount: 1, sectionIds: ["NTAA-2025-s22"] });
    const created = h.observe({
      kind: "verdict",
      agentId: "critic",
      runId: "r",
      claimId: "c1",
      claimText: "As a small business the shop need not file VAT returns.",
      verdict: "supported",
      sectionIds: ["NTAA-2025-s22"],
      quote: "The provision of subsection (1) shall not apply to a small business.",
      quoteVerified: true,
      reason: "small business",
    });
    const fact = created.find((c) => c.layer === "long_term");
    expect(fact).toMatchObject({ type: "factual", source: "critic:verified" });
    expect(fact?.derivedFrom).toEqual(expect.arrayContaining([tool!.id]));
    // an unverified or struck verdict stays short-term only
    const struck = h.observe({ kind: "verdict", agentId: "critic", runId: "r", claimId: "c2", claimText: "x", verdict: "struck", sectionIds: ["NTA-2025-s147"], quote: null, quoteVerified: false, reason: "" });
    expect(struck.every((c) => c.layer === "short_term")).toBe(true);
  });

  it("parses model extraction output robustly and falls back to direct capture", () => {
    expect(parseMemoryStrings('```json\n["VAT is 7.5%", "", 3, {"content": "returns monthly"}]\n``` trailing')).toEqual(["VAT is 7.5%", "returns monthly"]);
    expect(parseMemoryStrings("no json here")).toEqual([]);
  });
});

describe("TrustLedgerService", () => {
  it("is append-only JSONL, queryable by memory, action and run, and exportable", () => {
    const dirs = freshDirs();
    const h = new HMem({ ...dirs, now });
    const [m] = h.observe({ kind: "outcome", agentId: "pipeline", runId: "r9", success: true, summary: "3 claims" });
    const file = join(dirs.logDir, "ledger.jsonl");
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines.every((l) => JSON.parse(l).timestamp)).toBe(true);
    expect(h.ledger.query({ memoryId: m!.id, action: "create", runId: "r9" })).toHaveLength(1);
    expect(h.ledger.export({ runId: "r9" }).split("\n").length).toBeGreaterThanOrEqual(1);
    const before = readFileSync(file, "utf-8");
    h.observe({ kind: "outcome", agentId: "pipeline", runId: "r10", success: false, summary: "0 claims" });
    expect(readFileSync(file, "utf-8").startsWith(before)).toBe(true); // appended, never rewritten
  });
});

describe("Researcher across runs", () => {
  const profile: Profile = {
    business_type: "sole_proprietor",
    sector: "retail",
    state: "Lagos",
    lga: "Ikeja",
    turnover_band: "under_25m",
    fixed_assets_band: "under_250m",
    employees: 3,
    has_premises: true,
    has_signage: true,
  };
  const receipt = { receipt_id: "r", decision_id: "d", requested_model: "m", routed_model: "m", provider: "p", label: "", tier: "", kind: "", input_tokens: 1, output_tokens: 1, latency_ms: 1, signed: true };
  const toolTurn = (args: unknown) => ({ message: { role: "assistant" as const, content: null, tool_calls: [{ id: "c", type: "function" as const, function: { name: "run_sql", arguments: JSON.stringify(args) } }] }, receipt, raw_id: "x" });
  const text = (content: string) => ({ message: { role: "assistant" as const, content }, receipt, raw_id: "x" });
  const empty = JSON.stringify({ claims: [], notes: [], unanswered: [] });

  it("a second run retrieves what the first found, marked and logged as from an earlier run", async () => {
    vi.mocked(runSql).mockResolvedValue({ columns: ["section_id", "act_id", "section_no", "heading", "tier", "text"], rows: [["NTAA-2025-s22", "NTAA-2025", "22", "Returns for value added tax", "federal", "returns text"]] });
    const dirs = freshDirs();
    const question = "What taxes and levies does my business have to pay?";

    vi.mocked(chat).mockReset().mockResolvedValueOnce(toolTurn({ sql: "SELECT * FROM taxmap.sections WHERE lower(text) LIKE '%value added tax%'" })).mockResolvedValueOnce(text(empty));
    const one = new HMem({ ...dirs, now });
    await research(profile, question, one.runMemory("run-1"), { coverage: false });
    one.endRun("run-1");

    clock = hours(2);
    vi.mocked(chat).mockReset().mockResolvedValueOnce(toolTurn({ sql: "SELECT * FROM taxmap.sections WHERE lower(heading) LIKE '%registration%'" })).mockResolvedValueOnce(text(empty));
    const two = new HMem({ ...dirs, now });
    await research(profile, question, two.runMemory("run-2"), { coverage: false });

    const secondTurn = (vi.mocked(chat).mock.calls[1]?.[0] as ChatOptions).messages[1]?.content ?? "";
    expect(secondTurn).toContain("NTAA-2025-s22 (Returns for value added tax) [from an earlier run: fetch again before citing]");
    expect(two.stats("run-2").retrieved_from_prior_runs).toBeGreaterThanOrEqual(1);
    expect(two.ledger.query({ runId: "run-2", action: "read" }).some((e) => e.details?.fromEarlierRun === true && e.details?.originRunId === "run-1")).toBe(true);
  });
});
