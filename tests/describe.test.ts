import { describe, expect, it } from "vitest";
import {
  criticDetail,
  describeCriticStep,
  describeHandoff,
  describeResearcherStep,
  describeVerdict,
  researcherDetail,
  verdictDetail,
} from "../src/api/describe.js";
import type { CheckedClaim, TraceStep } from "../src/agents/types.js";

const step = (kind: TraceStep["kind"], detail: unknown): TraceStep => ({ kind, ts: "t", detail });
const TOOL_NAMES = /browse_part|get_sections|run_sql/;

describe("progress lines", () => {
  it("shows one line per tool step: the call and the requesting turn are silent", () => {
    expect(describeResearcherStep(step("model_turn", { turn: 3, tool_calls: ["get_sections"] }))).toBe("");
    expect(describeResearcherStep(step("tool_call", { name: "get_sections" }))).toBe("");
    expect(describeResearcherStep(step("model_turn", { turn: 8, tool_calls: [] }))).toBe("Researcher drafts the answer");
  });

  it("describes tool steps in plain words, with no tool names", () => {
    const five = ["NTA-2025-s143", "NTA-2025-s144", "NTA-2025-s145", "NTA-2025-s146", "NTA-2025-s147"];
    expect(describeResearcherStep(step("tool_result", { tool: "get_sections", requested: five, not_found: [] }))).toBe("Researcher read 5 sections in full");
    expect(describeResearcherStep(step("tool_result", { tool: "get_sections", requested: ["NTA-2025-s201"], not_found: [] }))).toBe(
      "Researcher read section 201 of the Nigeria Tax Act in full",
    );
    expect(describeResearcherStep(step("tool_result", { tool: "run_sql", sql_run: "SELECT * FROM taxmap.sections LIMIT 40", row_count: 32 }))).toBe(
      "Researcher searched the Acts: 32 matches",
    );
    expect(describeResearcherStep(step("tool_result", { tool: "run_sql", row_count: 1 }))).toBe("Researcher searched the Acts: 1 match");
    expect(
      describeResearcherStep(
        step("tool_result", { tool: "browse_part", requested: "NTA-2025 CHAPTER SIX VALUE ADDED TAX PART I – IMPOSITION OF VALUE ADDED TAX", row_count: 8 }),
      ),
    ).toBe("Researcher browsed Chapter Six, Part I (Imposition of Value Added Tax) of the Nigeria Tax Act: 8 sections");
    expect(describeResearcherStep(step("tool_result", { tool: "browse_part", requested: "NTA-2025 CHAPTER ONE – OBJECTIVE AND APPLICATION (none)", row_count: 2 }))).toBe(
      "Researcher browsed Chapter One (Objective and Application) of the Nigeria Tax Act: 2 sections",
    );
    expect(describeResearcherStep(step("tool_result", { tool: "browse_part", requested: "NTA-2025 CHAPTER SIX VALUE ADDED TAX PART II – REMITTANCES AND RECOVERY OF VAT", row_count: 7 }))).toBe(
      "Researcher browsed Chapter Six, Part II (Remittances and Recovery of VAT) of the Nigeria Tax Act: 7 sections",
    );
    expect(describeResearcherStep(step("tool_result", { tool: "browse_part", requested: "NTAA-2025 PART II", row_count: 6, by: "agent" }))).toBe(
      "Researcher browsed Part II of the Nigeria Tax Administration Act: 6 sections",
    );
    for (const d of [{ tool: "run_sql", repeat: true }, { tool: "get_sections", error: "bad id" }, { tool: "browse_part", requested: "NTA-2025 PART I", row_count: 1 }]) {
      expect(describeResearcherStep(step("tool_result", d))).not.toMatch(TOOL_NAMES);
    }
  });

  it("uses one actor vocabulary, Researcher and Critic, and never 'Agent'", () => {
    const lines = [
      describeResearcherStep(step("tool_result", { tool: "browse_part", requested: "NTAA-2025 PART II", row_count: 6, by: "agent" })),
      researcherDetail(step("tool_result", { tool: "browse_part", requested: "NTAA-2025 PART II", row_count: 6, by: "agent" })),
      describeResearcherStep(step("model_turn", { phase: "coverage", area: "b" })),
    ];
    for (const l of lines) {
      expect(l).toMatch(/^(?:Researcher|Critic)\b/);
      expect(l).not.toMatch(/\bagent\b/i);
    }
  });

  it("rewrites internal lines in user language and keeps the technical line for the run log", () => {
    const retry = step("model_turn", { phase: "draft_retry" });
    expect(describeResearcherStep(retry)).toBe("Taking longer on the draft; trying again");
    expect(researcherDetail(retry)).toBe("Drafting call failed; retrying with a larger output budget");
    const sql = step("tool_result", { tool: "run_sql", sql_run: "SELECT * FROM taxmap.sections", row_count: 4 });
    expect(researcherDetail(sql)).toBe("Researcher: run_sql on taxmap.sections, 4 rows");
    expect(describeResearcherStep(step("model_turn", { phase: "coverage", area: "e" }))).toBe("Researcher reviews what it found on records and returns");
  });

  it("gives each claim one Critic line: the per-section reads are silent and the verdict says what was read", () => {
    const read = step("model_turn", { claim_id: "c5", piece: "NTA-2025-s143", verdict: "struck" });
    expect(describeCriticStep(read)).toBe("");
    expect(criticDetail(read)).toBe("Critic read claim c5 (NTA-2025-s143): struck");
    const c = { claim: { id: "c5", text: "t", section_ids: ["NTA-2025-s143", "NTA-2025-s144"], type: "obligation" }, verdict: "struck" } as unknown as CheckedClaim;
    expect(describeVerdict(c)).toBe("Critic checked claim 5 against sections 143 and 144 of the Nigeria Tax Act: set aside");
    expect(verdictDetail(c)).toBe("Critic: claim c5 struck (NTA-2025-s143, NTA-2025-s144)");
    const one = { ...c, claim: { ...c.claim, id: "c1", section_ids: ["NTAA-2025-s4"] }, verdict: "supported" } as CheckedClaim;
    expect(describeVerdict(one)).toBe("Critic checked claim 1 against section 4 of the Nigeria Tax Administration Act: applies to you");
    expect(describeCriticStep(step("model_turn", { claim_id: "c3", error: "HTTP 502" }))).toBe("Critic is taking longer on claim 3; trying again");
  });

  it("describes the handoff in plain words", () => {
    expect(describeHandoff(6, 28, 5)).toBe("Researcher finished: 6 claims drafted from 28 sections, using 5 notes from earlier runs. Critic started checking them");
    expect(describeHandoff(1, 1, 0)).toBe("Researcher finished: 1 claim drafted from 1 section. Critic started checking it");
  });
});
