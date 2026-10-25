// One live run: Researcher, then Critic, with each step reported as an event, and the engines updated
// when it finishes.
import { critique } from "../agents/critic.js";
import { research } from "../agents/researcher.js";
import type { CheckedClaim, Draft, Profile, ResearchResult, TraceStep } from "../agents/types.js";
import { randomUUID } from "node:crypto";
import { getEngines } from "../engines/index.js";
import { mineRunOutcome, runIngestInput } from "./engine_io.js";
import type { Receipt } from "../providers/meterless.js";
import { criticDetail, describeCriticStep, describeHandoff, describeResearcherStep, describeVerdict, handoffDetail, researcherDetail, verdictDetail } from "./describe.js";
import type { NewRunEvent, PipelineOutput, QueryRow, ReceiptRow } from "./types.js";

export interface PipelineHooks {
  onEvent(e: NewRunEvent): void;
}

const now = () => new Date().toISOString();

/** The SQL the Researcher (not the agent) ran, with row counts, for "Show working". */
export function queriesFrom(trace: TraceStep[]): QueryRow[] {
  return trace
    .filter((s) => s.kind === "tool_result" && (s.detail as { tool?: string }).tool === "run_sql")
    .map((s) => {
      const d = s.detail as { sql_run?: string; sql_requested?: string; row_count?: number; error?: string; repeat?: number };
      const sql = d.sql_run ?? d.sql_requested ?? (d.repeat ? "(repeated query: earlier result reused)" : "");
      return { sql, row_count: d.row_count ?? 0, ...(d.error ? { error: d.error } : {}) };
    });
}

/** Assembles the run's result from the two agents' outputs. */
export function buildOutput(
  profile: Profile,
  question: string,
  res: Pick<ResearchResult, "draft" | "trace" | "receipts" | "sections_read">,
  checked: CheckedClaim[],
  criticReceipts: Receipt[],
): PipelineOutput {
  const receipts: ReceiptRow[] = [
    ...res.receipts.map((r) => ({ ...r, agent: "researcher" as const })),
    ...criticReceipts.map((r) => ({ ...r, agent: "critic" as const })),
  ].map((r, i) => ({ ...r, call: i + 1 }));
  const defs = new Map<string, { section_id: string; term: string; definition: string }>();
  for (const c of checked) for (const d of c.definitions ?? []) defs.set(`${d.section_id}|${d.term}`, d);
  const count = (v: string) => checked.filter((c) => c.verdict === v).length;
  return {
    profile,
    question,
    draft: res.draft,
    checked,
    receipts,
    sections_read: Object.entries(res.sections_read).map(([section_id, s]) => ({ section_id, heading: s.heading })),
    definitions: [...defs.values()],
    queries: queriesFrom(res.trace),
    totals: {
      supported: count("supported"),
      qualified: count("qualified"),
      struck: count("struck"),
      unchecked: count("unchecked"),
      tokens_in: receipts.reduce((n, r) => n + r.input_tokens, 0),
      tokens_out: receipts.reduce((n, r) => n + r.output_tokens, 0),
      model_calls: receipts.length,
      signed_receipts: receipts.filter((r) => r.signed).length,
    },
  };
}

/**
 * research() then critique(), reporting each step to `hooks` as it happens. The Researcher reads and
 * writes H-MEM across runs; the Critic writes facts through the World Model; the finished run is
 * mined into H-MEM and ingested into the World Model.
 */
export async function runPipeline(profile: Profile, question: string, hooks: PipelineHooks, opts: { runId?: string } = {}): Promise<PipelineOutput> {
  const runId = opts.runId ?? randomUUID();
  const { hmem, world } = getEngines();
  hmem.startRun(runId);
  hooks.onEvent({ type: "status", ts: now(), agent: "system", text: "Researcher started", data: null });
  const res = await research(profile, question, hmem.runMemory(runId, "researcher"), {
    onTrace: (step) =>
      hooks.onEvent({ type: "trace", ts: step.ts, agent: "researcher", text: describeResearcherStep(step), detail: researcherDetail(step), data: step }),
  });
  const draft: Draft = res.draft;
  const prior = hmem.stats(runId).retrieved_from_prior_runs;
  hmem.observe({
    kind: "node_complete",
    agentId: "researcher",
    runId,
    node: "research",
    summary: `${draft.claims.length} claims from ${Object.keys(res.sections_read).length} sections read in full`,
  });
  hmem.observe({ kind: "handoff", agentId: "researcher", runId, to: "critic", summary: draft.claims.map((c) => `${c.id}: ${c.text}`).join(" | ").slice(0, 500) });
  hooks.onEvent({
    type: "status",
    ts: now(),
    agent: "system",
    text: describeHandoff(draft.claims.length, Object.keys(res.sections_read).length, prior),
    detail: handoffDetail(draft.claims.length, Object.keys(res.sections_read).length, prior),
    data: null,
  });
  const crit = await critique(draft, res.sections_read, profile, world.forRun(runId), {
    onTrace: (step) => hooks.onEvent({ type: "trace", ts: step.ts, agent: "critic", text: describeCriticStep(step), detail: criticDetail(step), data: step }),
    onChecked: (c) => hooks.onEvent({ type: "verdict", ts: now(), agent: "critic", text: describeVerdict(c), detail: verdictDetail(c), data: c }),
  });
  const out = buildOutput(profile, question, res, crit.checked, crit.receipts);
  world.ingestRun(runIngestInput(runId, now(), Object.keys(res.sections_read), draft, crit.checked, res.sections_read));
  mineRunOutcome(hmem, runId, crit.checked);
  hmem.endRun(runId);
  return { ...out, world_run_id: runId, memory: hmem.stats(runId), world: world.stats(runId) };
}
