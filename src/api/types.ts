import type { CheckedClaim, Draft, Profile } from "../agents/types.js";
import type { Receipt } from "../providers/meterless.js";

export type RunMode = "live" | "sample";
export type RunAgent = "researcher" | "critic" | "system";

/** One server-sent event. `text` is the plain-language line the page shows; `data` is the raw step. */
export interface RunEvent {
  seq: number;
  type: "trace" | "verdict" | "status" | "result" | "failed";
  ts: string;
  agent: RunAgent;
  text: string;
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
  started_at: string;
  finished_at: string;
}

/** The pipeline's output before the run store adds the run id and mode. */
export type PipelineOutput = Omit<RunResult, "run_id" | "mode" | "sample" | "started_at" | "finished_at">;
