import type { CheckedClaim, TraceStep } from "../agents/types.js";

type D = Record<string, unknown>;

const tableOf = (sql: unknown) => /from\s+([\w.]+)/i.exec(String(sql ?? ""))?.[1] ?? "the statute tables";
const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const rows = (n: unknown) => `${Number(n ?? 0)} ${Number(n) === 1 ? "row" : "rows"}`;

/** "NTA-2025-s143 … and 4 more" */
const firstAndMore = (xs: string[]) => (xs.length > 1 ? `${xs[0]} … and ${xs.length - 1} more` : (xs[0] ?? "no sections"));

/**
 * The one-line, plain-language description of a Researcher trace step for the progress panel, or ""
 * for steps that add no line. A tool step shows once, on its result ("Researcher: get_sections
 * NTA-2025-s143 … and 4 more"): the model turn that requested it and the call itself are silent.
 */
export function describeResearcherStep(step: TraceStep): string {
  const d = (step.detail ?? {}) as D;
  if (step.kind === "tool_call") return "";
  if (step.kind === "tool_result") {
    const who = d.by === "agent" ? "Agent" : "Researcher";
    const tool = String(d.tool ?? "tool");
    if (d.repeat) return `${who}: ${tool} repeated an earlier call, earlier result reused`;
    if (d.error) return `${who}: ${tool} rejected (${String(d.error)})`;
    if (tool === "run_sql") return `${who}: run_sql on ${tableOf(d.sql_run ?? d.sql_requested)}, ${rows(d.row_count)}`;
    if (tool === "browse_part") return `${who}: browse_part ${String(d.requested ?? "a Part")}, ${Number(d.row_count ?? 0)} sections`;
    if (tool === "get_sections") {
      const got = ids(d.requested).filter((id) => !ids(d.not_found).includes(id));
      return `${who}: get_sections ${firstAndMore(got)}`;
    }
    return `${who}: ${tool}`;
  }
  // model turns
  if (d.phase === "coverage") return `Researcher targets checklist area (${String(d.area)})`;
  if (d.phase === "coverage_draft") return "Researcher revises the draft for the checklist areas";
  if (d.phase === "coverage_correction") return "Researcher corrects the revised draft";
  if (d.phase === "draft_retry") return "Drafting call failed; retrying with a larger output budget";
  if (ids(d.tool_calls).length) return "";
  return "Researcher drafts the answer";
}

/** Critic trace steps: one per piece of cited text judged. */
export function describeCriticStep(step: TraceStep): string {
  const d = (step.detail ?? {}) as D;
  const piece = d.piece ? ` (${String(d.piece)})` : "";
  if (d.error) return `Critic could not check claim ${String(d.claim_id)}${piece}: call failed`;
  if (d.verdict === "unparseable") return `Critic reply for claim ${String(d.claim_id)}${piece} did not parse; asking again`;
  return `Critic read claim ${String(d.claim_id)}${piece}: ${String(d.verdict ?? "judged")}`;
}

const VERDICT_WORDS: Record<string, string> = {
  supported: "supported",
  qualified: "qualified",
  struck: "struck",
  unchecked: "could not be verified",
};

export function describeVerdict(c: CheckedClaim): string {
  return `Critic: claim ${c.claim.id} ${VERDICT_WORDS[c.verdict] ?? c.verdict}`;
}
