// Feeds a finished run (live or sample) to the two engines: the World Model ingests its verdicts, and
// H-MEM mines its outcome.
import { corpus } from "../agents/glossary.js";
import type { CheckedClaim, Draft } from "../agents/types.js";
import type { Engines } from "../engines/index.js";
import type { RunIngestInput } from "../engines/world_model/index.js";

/** The World Model's view of a finished run; section text comes from the corpus when not given. */
export function runIngestInput(
  runId: string,
  finishedAt: string,
  sectionIds: string[],
  draft: Draft,
  checked: CheckedClaim[],
  read: Record<string, { heading: string; text: string; act_id: string; section_no: string }> = {},
): RunIngestInput {
  const defs = new Map<string, { section_id: string; term: string; definition: string }>();
  for (const c of checked) for (const d of c.definitions ?? []) defs.set(`${d.section_id}|${d.term}`, d);
  const ids = new Set([...sectionIds, ...checked.flatMap((c) => c.claim.section_ids), ...[...defs.values()].map((d) => d.section_id)]);
  const sections = [...ids].flatMap((id) => {
    const s = read[id] ?? corpus().get(id);
    return s ? [{ section_id: id, act_id: s.act_id, section_no: s.section_no, heading: s.heading ?? "", text: s.text }] : [];
  });
  return { runId, finishedAt, sections, definitions: [...defs.values()], claims: draft.claims, checked };
}

/** Feeds a finished run's verdicts and outcome to H-MEM (no-model mining). */
export function mineRunOutcome(hmem: Engines["hmem"], runId: string, checked: CheckedClaim[]): void {
  for (const c of checked) {
    hmem.observe({
      kind: "verdict",
      agentId: "critic",
      runId,
      claimId: c.claim.id,
      claimText: c.claim.text,
      verdict: c.verdict,
      sectionIds: c.claim.section_ids,
      quote: c.quote,
      quoteVerified: c.quote_verified,
      reason: c.reason,
    });
  }
  const count = (v: string) => checked.filter((c) => c.verdict === v).length;
  hmem.observe({
    kind: "outcome",
    agentId: "pipeline",
    runId,
    success: checked.length > 0 && count("unchecked") < checked.length,
    summary: `${checked.length} claims: ${count("supported")} supported, ${count("qualified")} qualified, ${count("struck")} struck, ${count("unchecked")} unchecked`,
  });
}
