import { describe, expect, it } from "vitest";
import { describeResearcherStep } from "../src/api/describe.js";
import type { TraceStep } from "../src/agents/types.js";

const step = (kind: TraceStep["kind"], detail: unknown): TraceStep => ({ kind, ts: "t", detail });

describe("progress lines", () => {
  it("shows one line per tool step: the call and the requesting turn are silent", () => {
    expect(describeResearcherStep(step("model_turn", { turn: 3, tool_calls: ["get_sections"] }))).toBe("");
    expect(describeResearcherStep(step("tool_call", { name: "get_sections" }))).toBe("");
    expect(
      describeResearcherStep(step("tool_result", { tool: "get_sections", requested: ["NTA-2025-s143", "NTA-2025-s144", "NTA-2025-s145", "NTA-2025-s146", "NTA-2025-s147"], not_found: [] })),
    ).toBe("Researcher: get_sections NTA-2025-s143 … and 4 more");
    expect(describeResearcherStep(step("tool_result", { tool: "run_sql", sql_run: "SELECT * FROM taxmap.sections LIMIT 40", row_count: 32 }))).toBe(
      "Researcher: run_sql on taxmap.sections, 32 rows",
    );
    expect(describeResearcherStep(step("tool_result", { tool: "browse_part", requested: "NTAA-2025 PART II", row_count: 6, by: "agent" }))).toBe(
      "Agent: browse_part NTAA-2025 PART II, 6 sections",
    );
    expect(describeResearcherStep(step("model_turn", { turn: 8, tool_calls: [] }))).toBe("Researcher drafts the answer");
  });
});
