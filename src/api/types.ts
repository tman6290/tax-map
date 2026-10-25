import type { CheckedClaim, Draft, Profile } from "../agents/types.js";
import type { HMemRunStats } from "../engines/hmem/index.js";
import type { Fact } from "../engines/types.js";
import type { WorldRunStats } from "../engines/world_model/index.js";
import type { Receipt } from "../providers/meterless.js";

export type RunMode = "live" | "sample";
export type RunAgent = "researcher" | "critic" | "system";

/** One server-sent event. `text` is the plain-language line the page shows; `data` is the raw step. */
export interface RunEvent {
  seq: number;
  type: "trace" | "verdict" | "status" | "result" | "failed";
  ts: string;
  agent: RunAgent;
  /** The plain progress line for the business owner; "" for steps that add no line. */
  text: string;
  /** The technical line for the run log under "See how this answer was produced". */
  detail?: string;
  data: unknown;
}

export type NewRunEvent = Omit<RunEvent, "seq">;

export interface ReceiptRow extends Receipt {
  call: number;
  agent: "researcher" | "critic";
}

export interface QueryRow {
  sql: string;
  row_count: number;
  error?: string;
}

export interface Totals {
  supported: number;
  qualified: number;
  struck: number;
  unchecked: number;
  tokens_in: number;
  tokens_out: number;
  model_calls: number;
  signed_receipts: number;
}

/** What one run produces; the final "result" event and GET /api/runs/:id carry it. */
export interface RunResult {
  run_id: string;
  mode: RunMode;
  sample?: string;
  profile: Profile;
  question: string;
  draft: Draft;
  checked: CheckedClaim[];
  receipts: ReceiptRow[];
  sections_read: Array<{ section_id: string; heading: string }>;
  definitions: Array<{ section_id: string; term: string; definition: string }>;
  queries: QueryRow[];
  totals: Totals;
  /** The run id the engines know this run by (a sample replay uses "sample:<name>"). */
  world_run_id?: string;
  /** H-MEM figures for the run: what was retrieved from earlier runs, what is stored. */
  memory?: HMemRunStats;
  /** World Model figures: facts held overall and from this run. */
  world?: WorldRunStats;
  /**
   * "Not answered" and "Notes" as the page shows them (describe.ts pageLists): one entry per checklist
   * area, internal names rewritten. The raw entries stay in `draft`, for the run log.
   */
  page?: { unanswered: string[]; notes: string[] };
  /** Verified facts for this run, read from the World Model when the result is fetched. */
  verified_facts?: Fact[];
  started_at: string;
  finished_at: string;
}

/** The pipeline's output before the run store adds the run id and mode. */
export type PipelineOutput = Omit<RunResult, "run_id" | "mode" | "sample" | "started_at" | "finished_at">;
