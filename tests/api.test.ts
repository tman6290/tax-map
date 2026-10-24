import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineHooks } from "../src/api/pipeline.js";
import type { PipelineOutput, RunEvent, RunResult } from "../src/api/types.js";

vi.mock("../src/api/pipeline.js", () => ({ runPipeline: vi.fn() }));

const { runPipeline } = await import("../src/api/pipeline.js");
const { app } = await import("../src/server.js");
const { resetEngines } = await import("../src/engines/index.js");
const pipelineMock = vi.mocked(runPipeline);

const profile = {
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
const receipt = { receipt_id: "rcpt_1", decision_id: "d", requested_model: "m", routed_model: "m", provider: "nvidia", label: "", tier: "A", kind: "cloud", input_tokens: 10, output_tokens: 5, latency_ms: 100, signed: true };
const output: PipelineOutput = {
  profile: profile as PipelineOutput["profile"],
  question: "What taxes?",
  draft: { claims: [{ id: "c1", type: "obligation", text: "Register for a Tax ID.", section_ids: ["NTAA-2025-s4"], tier: "federal", agency: null }], notes: [], unanswered: [] },
  checked: [],
  receipts: [{ ...receipt, call: 1, agent: "researcher" }],
  sections_read: [{ section_id: "NTAA-2025-s4", heading: "Taxable person" }],
  definitions: [],
  queries: [{ sql: "SELECT 1 FROM taxmap.sections", row_count: 1 }],
  totals: { supported: 0, qualified: 0, struck: 0, unchecked: 0, tokens_in: 10, tokens_out: 5, model_calls: 1, signed_receipts: 1 },
};

let base = "";
let server: ReturnType<typeof app.listen>;
let dir = "";

beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taxmap-api-"));
  vi.stubEnv("RUNS_DIR", join(dir, "runs"));
  // the engines write into the temp directory, never data/ or logs/
  for (const [k, sub] of [["HMEM_DIR", "memory"], ["HMEM_LOG_DIR", "hmem-logs"], ["WM_DIR", "world"], ["WM_LOG_DIR", "world-logs"]]) vi.stubEnv(k!, join(dir, sub!));
  resetEngines();
  pipelineMock.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  fetch(`${base}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Reads the whole SSE stream (the server ends it after the result) into events. */
async function readEvents(runId: string): Promise<Array<{ event: string; data: RunEvent }>> {
  const res = await fetch(`${base}/api/runs/${runId}/events`, { signal: AbortSignal.timeout(10_000) });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.includes("data: "))
    .map((b) => ({
      event: /^event: (.*)$/m.exec(b)?.[1] ?? "",
      data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? "{}") as RunEvent,
    }));
}

describe("POST /api/runs", () => {
  it("rejects an invalid profile", async () => {
    const res = await post({ profile: { ...profile, state: "Ogun" }, question: "q?" });
    expect(res.status).toBe(400);
    expect((await res.json()).issues.join(" ")).toMatch(/profile.state/);
  });

  it("creates a live run, streams its events and a result, and stores the result", async () => {
    pipelineMock.mockImplementation(async (_p, _q, hooks: PipelineHooks) => {
      hooks.onEvent({ type: "trace", ts: "t", agent: "researcher", text: "Researcher queried taxmap.sections: 32 rows", data: { kind: "tool_result" } });
      await new Promise((r) => setTimeout(r, 20));
      hooks.onEvent({ type: "verdict", ts: "t", agent: "critic", text: "Critic: claim c1 supported", data: {} });
      return output;
    });

    const res = await post({ profile, question: "What taxes?" });
    expect(res.status).toBe(202);
    const { run_id, mode } = await res.json();
    expect(mode).toBe("live");

    const events = await readEvents(run_id);
    expect(events.map((e) => e.event)).toEqual(["trace", "verdict", "result"]);
    expect(events[0]?.data.text).toBe("Researcher queried taxmap.sections: 32 rows");
    const result = events[2]?.data.data as { run_id: string; mode: string; totals: { model_calls: number } };
    expect(result).toMatchObject({ run_id, mode: "live", totals: { model_calls: 1 } });

    const stored = await fetch(`${base}/api/runs/${run_id}`);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({ run_id, mode: "live", draft: output.draft });
    expect(JSON.parse(readFileSync(join(dir, "runs", `${run_id}.json`), "utf-8"))).toMatchObject({ run_id });
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it("replays a sample in SAMPLE_MODE without calling the pipeline, and marks it as a sample", async () => {
    const samples = join(dir, "samples");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(samples);
    writeFileSync(
      join(samples, "retail.json"),
      JSON.stringify({
        name: "retail",
        recorded_at: "2026-10-24T00:00:00.000Z",
        profile,
        question: "What taxes?",
        events: [
          { seq: 1, type: "trace", ts: "t", agent: "researcher", text: "Read NTA-2025-s143 in full", data: {} },
          { seq: 2, type: "verdict", ts: "t", agent: "critic", text: "Critic: claim c2 struck", data: {} },
          { seq: 3, type: "result", ts: "t", agent: "system", text: "Run complete", data: {} },
        ],
        result: output,
      }),
    );
    vi.stubEnv("SAMPLE_MODE", "true");
    vi.stubEnv("SAMPLES_DIR", samples);
    vi.stubEnv("SAMPLE_DELAY_MS", "0");

    const res = await post({ profile: { ...profile, lga: "Surulere" }, question: "Anything?" });
    const { run_id, mode } = await res.json();
    expect(mode).toBe("sample");

    const events = await readEvents(run_id);
    expect(events.map((e) => e.event)).toEqual(["status", "trace", "verdict", "result"]);
    expect(events[0]?.data.text).toMatch(/^Sample run: replaying an answer recorded on \d{1,2} \w+ \d{4}$/);
    expect(events[0]?.data.detail).toMatch(/^Sample run: replaying the recorded run "retail"/); // the name stays in the run log
    expect(events[3]?.data.data).toMatchObject({ run_id, mode: "sample", sample: "retail", draft: output.draft });
    expect(pipelineMock).not.toHaveBeenCalled();
  });
});

describe("engines in the API", () => {
  it("a sample replay writes both engines; the result reads verified facts from the World Model; replaying again changes nothing", async () => {
    const samples = join(dir, "samples");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(samples);
    const checked = [
      {
        claim: { id: "c1", type: "exemption", text: "As a small business the shop need not file VAT returns.", section_ids: ["NTAA-2025-s22"], tier: "federal", agency: null },
        verdict: "supported",
        reason: "subsection (4)",
        quote: "The provision of subsection (1) shall not apply to a small business.",
        quote_verified: true,
        qualifier: null,
        definitions_used: ["NTAA-2025-s147"],
        definitions: [{ section_id: "NTAA-2025-s147", term: "small business", definition: '"small business" means ...' }],
        receipt: null,
      },
    ];
    const result = { ...output, draft: { ...output.draft, claims: [checked[0]!.claim] }, checked, sections_read: [{ section_id: "NTAA-2025-s22", heading: "Returns for value added tax" }] };
    writeFileSync(join(samples, "retail.json"), JSON.stringify({ name: "retail", recorded_at: "2026-10-24T00:00:00.000Z", profile, question: "q?", events: [], result }));
    vi.stubEnv("SAMPLE_MODE", "true");
    vi.stubEnv("SAMPLES_DIR", samples);
    vi.stubEnv("SAMPLE_DELAY_MS", "0");

    const replay = async () => {
      const { run_id } = await (await post({ profile, question: "What do I owe?" })).json();
      await readEvents(run_id);
      return (await (await fetch(`${base}/api/runs/${run_id}`)).json()) as RunResult;
    };
    const first = await replay();
    expect(first.world_run_id).toBe("sample:retail");
    expect(first.world).toMatchObject({ verified_facts_this_run: 1, runs_ingested: 1 });
    expect(first.memory?.memories_by_layer.long_term).toBe(1); // the Critic-verified fact
    expect(first.verified_facts).toEqual([expect.objectContaining({ claim_id: "c1", section_id: "NTAA-2025-s22", verdict: "supported" })]);

    const ctx = await (await fetch(`${base}/api/runs/${first.run_id}/claims/c1/context`)).json();
    expect(ctx).toMatchObject({ schema: "wm.claim_context.v1", claim: { claimId: "c1", verdict: "supported" } });
    expect(ctx.sections[0].text).toContain("shall not apply to a small business"); // verbatim, from the corpus
    expect(ctx.definitions[0].term).toBe("small business");

    const second = await replay();
    expect(second.world).toEqual(first.world); // idempotent ingest
    expect(readFileSync(join(dir, "world-logs", "events.jsonl"), "utf-8")).toContain('"type":"ingest_skipped"');
    expect(readFileSync(join(dir, "hmem-logs", "ledger.jsonl"), "utf-8")).toContain('"action":"create"');
    expect(pipelineMock).not.toHaveBeenCalled();
  });
});

describe("reference endpoints", () => {
  it("serves health, the Acts and a section's full text", async () => {
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
    const acts = (await (await fetch(`${base}/api/acts`)).json()) as Array<{ act_id: string }>;
    expect(acts.map((a) => a.act_id)).toEqual(["NTA-2025", "NTAA-2025", "NRSEA-2025", "JRBEA-2025"]);
    const s22 = await (await fetch(`${base}/api/sections/NTAA-2025-s22`)).json();
    expect(s22).toMatchObject({ section_id: "NTAA-2025-s22", heading: "Returns for value added tax" });
    expect(s22.text).toContain("shall not apply to a small business");
    expect((await fetch(`${base}/api/sections/not-a-section`)).status).toBe(404);
    expect((await fetch(`${base}/api/runs/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
  });

  it("serves the page", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("<h1>Tax Map</h1>");
    expect(html).toContain("Tell Tax Map about your business. It reads Nigeria's 2025 tax laws, lists what you owe and what you're exempt from, and shows you the exact section behind every line.");
    expect(html).toContain("Fill in your business details.");
    expect(html).not.toContain("Lagos only for now");
    expect(html).not.toContain("Example values");
    expect((await fetch(`${base}/help.json`)).status).toBe(200);
  });
});
