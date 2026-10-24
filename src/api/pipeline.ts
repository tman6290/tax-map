import { critique } from "../agents/critic.js";
import { research } from "../agents/researcher.js";
import type { CheckedClaim, Draft, Profile, ResearchResult, TraceStep } from "../agents/types.js";
import { InMemoryRunMemory } from "../engines/hmem/index.js";
import { InMemoryWorldModel } from "../engines/world_model/index.js";
import type { Receipt } from "../providers/meterless.js";
import { describeCriticStep, describeResearcherStep, describeVerdict } from "./describe.js";
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

/** research() then critique(), reporting each step to `hooks` as it happens. */
export async function runPipeline(profile: Profile, question: string, hooks: PipelineHooks): Promise<PipelineOutput> {
  hooks.onEvent({ type: "status", ts: now(), agent: "system", text: "Researcher started", data: null });
  const res = await research(profile, question, new InMemoryRunMemory(), {
    onTrace: (step) => hooks.onEvent({ type: "trace", ts: step.ts, agent: "researcher", text: describeResearcherStep(step), data: step }),
  });
  const draft: Draft = res.draft;
  hooks.onEvent({
    type: "status",
    ts: now(),
    agent: "system",
    text: `Researcher finished: ${draft.claims.length} claims from ${Object.keys(res.sections_read).length} sections read. Critic started`,
    data: null,
  });
  const crit = await critique(draft, res.sections_read, profile, new InMemoryWorldModel(), {
    onTrace: (step) => hooks.onEvent({ type: "trace", ts: step.ts, agent: "critic", text: describeCriticStep(step), data: step }),
    onChecked: (c) => hooks.onEvent({ type: "verdict", ts: now(), agent: "critic", text: describeVerdict(c), data: c }),
  });
  return buildOutput(profile, question, res, crit.checked, crit.receipts);
}
