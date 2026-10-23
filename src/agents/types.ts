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

export interface SectionRead {
  heading: string;
  text: string;
  act_id: string;
  section_no: string;
}

export interface ResearchResult {
  draft: Draft;
  trace: TraceStep[];
  receipts: Receipt[];
  /** Every section fetched in full during the run, keyed by section_id. */
  sections_read: Record<string, SectionRead>;
}

/** "unchecked": the Critic call failed after retries, so the claim could not be verified (not a rejection). */
export type Verdict = "supported" | "qualified" | "struck" | "unchecked";

export interface CheckedClaim {
  claim: Claim;
  verdict: Verdict;
  reason: string;
  quote: string | null;
  quote_verified: boolean;
  qualifier: string | null;
  /** The receipt of the critic call that decided the verdict; null when no call was possible. */
  receipt: Receipt | null;
}

export interface CritiqueResult {
  checked: CheckedClaim[];
  receipts: Receipt[];
  trace: TraceStep[];
}
