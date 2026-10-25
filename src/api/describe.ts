import { isItemId, itemLabel, LEVIES_ACT } from "../agents/levies.js";
import type { CheckedClaim, TraceStep } from "../agents/types.js";

type D = Record<string, unknown>;

/**
 * Each run event carries two descriptions: `text`, the plain line the progress panel shows the
 * business owner, and `detail`, the technical line kept for the run log under "See how this answer
 * was produced". Only two actors appear in either: the Researcher and the Critic.
 */

/** Short names of the five Acts in the corpus (data/statutes/acts.json), as a reader says them. */
const ACT_NAMES: Record<string, string> = {
  "NTA-2025": "Nigeria Tax Act",
  "NTAA-2025": "Nigeria Tax Administration Act",
  "NRSEA-2025": "Nigeria Revenue Service (Establishment) Act",
  "JRBEA-2025": "Joint Revenue Board of Nigeria (Establishment) Act",
  "TLA-1998": "Taxes and Levies (Approved List for Collection) Act",
};
const actName = (id: string) => ACT_NAMES[id] ?? id;

/** Short user-facing names of the coverage checklist areas (src/agents/checklist.ts). */
const AREA_NAMES: Record<string, string> = {
  a: "registration and tax ID",
  b: "tax on business profits",
  c: "employer duties (PAYE)",
  d: "VAT",
  e: "records and returns",
  f: "levies",
};

/** list_levies tiers as a reader says them. */
const LEVY_TIER_WORDS: Record<string, string> = { federal: "federal", state: "State", lga: "local government" };

const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "NTA-2025-s143" -> { act: "NTA-2025", no: "143" } */
function splitId(id: string): { act: string; no: string } {
  const m = /^(.*-\d{4})-s(\d+)$/.exec(id);
  return m ? { act: m[1] ?? id, no: m[2] ?? "" } : { act: id, no: "" };
}

/** "section 201 of the Nigeria Tax Act", "sections 143 and 144 of the Nigeria Tax Act", or "3 sections". */
function sectionsPhrase(sectionIds: string[]): string {
  const [only] = sectionIds;
  if (sectionIds.length === 1 && only && isItemId(only)) return `${itemLabel(only)} of the ${actName(LEVIES_ACT)}`;
  const parts = sectionIds.map(splitId);
  const acts = new Set(parts.map((p) => p.act));
  if (parts.length === 0) return "no sections";
  if (acts.size > 1) return count(parts.length, "section", "sections");
  const nos = parts.map((p) => p.no);
  const list = nos.length === 1 ? nos[0] : `${nos.slice(0, -1).join(", ")} and ${nos[nos.length - 1]}`;
  return `${nos.length === 1 ? "section" : "sections"} ${list} of the ${actName(parts[0]?.act ?? "")}`;
}

const SMALL_WORDS = new Set(["of", "and", "the", "on", "or", "for", "in", "to", "a", "an", "by", "with", "from", "at"]);
const ACRONYMS = new Set(["VAT", "PAYE", "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII"]);

/** "IMPOSITION OF VALUE ADDED TAX" -> "Imposition of Value Added Tax" (statute headings are set in capitals). */
function headingCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const up = w.toUpperCase();
      if (ACRONYMS.has(up)) return up;
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/**
 * The browse_part label "NTA-2025 CHAPTER SIX VALUE ADDED TAX PART I – IMPOSITION OF VALUE ADDED TAX"
 * as "Chapter Six, Part I (Imposition of Value Added Tax) of the Nigeria Tax Act".
 */
function partPhrase(requested: string): string {
  const [act = "", ...rest] = requested.replace(/\(none\)/g, "").trim().split(/\s+/);
  const tail = rest.join(" ");
  const chapter = /CHAPTER\s+([A-Z]+)(?:\s*[–-]\s*|\s+)?(.*?)(?=\s+PART\s+[IVXLC\d]+\b|$)/i.exec(tail);
  const part = /PART\s+([IVXLC\d]+)\b\s*(?:[–-]\s*)?(.*)$/i.exec(tail);
  const where: string[] = [];
  let title = "";
  if (chapter) where.push(`Chapter ${headingCase(chapter[1] ?? "")}`);
  if (part) {
    where.push(`Part ${(part[1] ?? "").toUpperCase()}`);
    title = part[2] ?? "";
  } else if (chapter) {
    title = chapter[2] ?? "";
  }
  const place = where.length ? where.join(", ") : "a Part";
  return `${place}${title.trim() ? ` (${headingCase(title.trim())})` : ""} of the ${actName(act)}`;
}

const tableOf = (sql: unknown) => /from\s+([\w.]+)/i.exec(String(sql ?? ""))?.[1] ?? "the statute tables";
const rows = (n: unknown) => count(Number(n ?? 0), "row", "rows");

/** "NTA-2025-s143 … and 4 more" */
const firstAndMore = (xs: string[]) => (xs.length > 1 ? `${xs[0]} … and ${xs.length - 1} more` : (xs[0] ?? "no sections"));

/**
 * The plain progress line for a Researcher trace step, or "" for steps that add no line. A tool step
 * shows once, on its result: the model turn that requested it and the call itself are silent.
 */
export function describeResearcherStep(step: TraceStep): string {
  const d = (step.detail ?? {}) as D;
  if (step.kind === "tool_call") return "";
  if (step.kind === "tool_result") {
    const tool = String(d.tool ?? "tool");
    if (d.repeat) return "Researcher reused the result of an earlier search";
    if (d.error) return "Researcher's lookup did not work; trying another way";
    if (tool === "run_sql") return `Researcher searched the Acts: ${count(Number(d.row_count ?? 0), "match", "matches")}`;
    if (tool === "browse_part") return `Researcher browsed ${partPhrase(String(d.requested ?? ""))}: ${count(Number(d.row_count ?? 0), "section", "sections")}`;
    if (tool === "list_levies") return `Researcher read the ${LEVY_TIER_WORDS[String(d.requested)] ?? "listed"} levies in the ${actName(LEVIES_ACT)}: ${count(Number(d.row_count ?? 0), "item", "items")}`;
    if (tool === "get_sections") {
      const got = ids(d.requested).filter((id) => !ids(d.not_found).includes(id));
      if (!got.length) return "Researcher looked for sections that are not in the Acts";
      return got.length === 1 ? `Researcher read ${sectionsPhrase(got)} in full` : `Researcher read ${got.length} sections in full`;
    }
    return "Researcher looked something up in the Acts";
  }
  // model turns
  if (d.phase === "coverage") return `Researcher reviews what it found on ${AREA_NAMES[String(d.area)] ?? "a topic it had not covered"}`;
  if (d.phase === "coverage_draft") return "Researcher adds what it found to the draft";
  if (d.phase === "coverage_correction") return "Researcher tidies the updated draft";
  if (d.phase === "draft_retry") return "Taking longer on the draft; trying again";
  if (ids(d.tool_calls).length) return "";
  return "Researcher drafts the answer";
}

/** The technical line for a Researcher trace step, for the run log; "" where the step adds nothing. */
export function researcherDetail(step: TraceStep): string {
  const d = (step.detail ?? {}) as D;
  if (step.kind === "tool_call") return "";
  if (step.kind === "tool_result") {
    // "by: agent" marks lookups the Researcher's harness makes itself (read-before-cite, coverage)
    const who = d.by === "agent" ? "Researcher (automatic)" : "Researcher";
    const tool = String(d.tool ?? "tool");
    if (d.repeat) return `${who}: ${tool} repeated an earlier call, earlier result reused`;
    if (d.error) return `${who}: ${tool} rejected (${String(d.error)})`;
    if (tool === "run_sql") return `${who}: run_sql on ${tableOf(d.sql_run ?? d.sql_requested)}, ${rows(d.row_count)}`;
    if (tool === "browse_part") return `${who}: browse_part ${String(d.requested ?? "a Part")}, ${Number(d.row_count ?? 0)} sections`;
    if (tool === "list_levies") return `${who}: list_levies ${String(d.requested ?? "")}, ${Number(d.row_count ?? 0)} items`;
    if (tool === "get_sections") {
      const got = ids(d.requested).filter((id) => !ids(d.not_found).includes(id));
      return `${who}: get_sections ${firstAndMore(got)}`;
    }
    return `${who}: ${tool}`;
  }
  if (d.phase === "coverage") return `Researcher targets checklist area (${String(d.area)})`;
  if (d.phase === "coverage_draft") return "Researcher revises the draft for the checklist areas";
  if (d.phase === "coverage_correction") return "Researcher corrects the revised draft";
  if (d.phase === "draft_retry") return "Drafting call failed; retrying with a larger output budget";
  if (ids(d.tool_calls).length) return "";
  return "Researcher drafts the answer";
}

const claimNo = (id: unknown) => String(id ?? "").replace(/^c(?=\d+$)/, "");

/**
 * The plain progress line for a Critic trace step. Ordinary reads are silent: the claim's verdict
 * line says what the Critic read and decided, so each claim gets one line. Retries are shown.
 */
export function describeCriticStep(step: TraceStep): string {
  const d = (step.detail ?? {}) as D;
  if (d.phase === "plain_check") return "";
  if (d.error) return `Critic is taking longer on claim ${claimNo(d.claim_id)}; trying again`;
  if (d.verdict === "unparseable") return `Critic is re-reading claim ${claimNo(d.claim_id)}`;
  return "";
}

/** The technical line for a Critic trace step, for the run log. */
export function criticDetail(step: TraceStep): string {
  const d = (step.detail ?? {}) as D;
  if (d.phase === "plain_check") {
    if (d.ok === true) return `Critic plain-words check for claim ${String(d.claim_id)}: ok`;
    if (d.ok === false) return `Critic plain-words check for claim ${String(d.claim_id)}: replaced "${String(d.original)}" with ${d.fix ? `"${String(d.fix)}"` : "nothing (legal sentence shown)"}`;
    return `Critic plain-words check for claim ${String(d.claim_id)} did not complete (${String(d.error)}); legal sentence shown`;
  }
  const piece = d.piece ? ` (${String(d.piece)})` : "";
  if (d.rule === "levy_amount") return `Critic struck claim ${String(d.claim_id)}: it states an amount from the 1998 levies Act`;
  if (d.error) return `Critic could not check claim ${String(d.claim_id)}${piece}: call failed`;
  if (d.verdict === "unparseable") return `Critic reply for claim ${String(d.claim_id)}${piece} did not parse; asking again`;
  return `Critic read claim ${String(d.claim_id)}${piece}: ${String(d.verdict ?? "judged")}`;
}

/** The verdicts in the words the result cards use. */
const VERDICT_WORDS: Record<string, string> = {
  supported: "applies to you",
  qualified: "applies with a condition",
  struck: "set aside",
  unchecked: "could not be verified",
};

/** "Critic checked claim 1 against section 4 of the Nigeria Tax Administration Act: applies to you" */
export function describeVerdict(c: CheckedClaim): string {
  return `Critic checked claim ${claimNo(c.claim.id)} against ${sectionsPhrase(c.claim.section_ids)}: ${VERDICT_WORDS[c.verdict] ?? c.verdict}`;
}

export function verdictDetail(c: CheckedClaim): string {
  return `Critic: claim ${c.claim.id} ${c.verdict} (${c.claim.section_ids.join(", ")})`;
}

/** "Researcher finished: 6 claims from 28 sections, using 5 notes from earlier runs. Critic started checking them" */
export function describeHandoff(claims: number, sections: number, prior: number): string {
  return (
    `Researcher finished: ${count(claims, "claim", "claims")} drafted from ${count(sections, "section", "sections")}` +
    `${prior ? `, using ${count(prior, "note", "notes")} from earlier runs` : ""}. Critic started checking ${claims === 1 ? "it" : "them"}`
  );
}

export function handoffDetail(claims: number, sections: number, prior: number): string {
  return `Researcher finished: ${claims} claims from ${sections} sections read${prior ? `, using ${prior} memories from earlier runs` : ""}. Critic started`;
}
