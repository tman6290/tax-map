import type { Receipt } from "../providers/meterless.js";

export interface Profile {
  business_type: "sole_proprietor" | "company" | "partnership";
  sector: string;
  state: string;
  lga: string;
  turnover_band: "under_25m" | "25m_to_100m" | "over_100m";
  employees: number;
  has_premises: boolean;
  has_signage: boolean;
}

export interface Claim {
  id: string;
  text: string;
  section_ids: string[];
  tier: "federal" | "state" | "lga";
  agency: string | null;
}

export interface Draft {
  claims: Claim[];
  notes: string[];
  unanswered: string[];
}

export interface TraceStep {
  kind: "tool_call" | "tool_result" | "model_turn";
  ts: string;
  detail: unknown;
  receipt?: Receipt;
}

export interface ResearchResult {
  draft: Draft;
  trace: TraceStep[];
  receipts: Receipt[];
}
