import { beforeEach, describe, expect, it, vi } from "vitest";
import { guardSql, research } from "../src/agents/researcher.js";
import type { Profile } from "../src/agents/types.js";
import { runSql } from "../src/data/zetaris.js";
import { InMemoryRunMemory } from "../src/engines/hmem/index.js";
import { chat, type ChatMessage, type ChatOptions } from "../src/providers/meterless.js";

vi.mock("../src/providers/meterless.js", () => ({ chat: vi.fn() }));
vi.mock("../src/data/zetaris.js", () => ({ runSql: vi.fn() }));

const chatMock = vi.mocked(chat);
const sqlMock = vi.mocked(runSql);

const profile: Profile = {
  business_type: "sole_proprietor",
  sector: "retail",
  state: "Lagos",
  lga: "Ikeja",
  turnover_band: "under_25m",
  employees: 3,
  has_premises: true,
  has_signage: true,
};

let n = 0;
const receipt = () => ({
  receipt_id: `r${++n}`,
  decision_id: "d",
  requested_model: "m",
  routed_model: "nvidia/nemotron",
  provider: "nvidia",
  label: "",
  tier: "A",
  kind: "cloud",
  input_tokens: 10,
  output_tokens: 5,
  latency_ms: 1,
  signed: true,
});
const toolTurn = (name: string, args: unknown) => ({
  message: {
    role: "assistant" as const,
    content: null,
    tool_calls: [{ id: `call_${name}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
  },
  receipt: receipt(),
  raw_id: "x",
});
const textTurn = (content: string) => ({ message: { role: "assistant" as const, content }, receipt: receipt(), raw_id: "x" });
const draftJson = (section_ids: string[]) =>
  JSON.stringify({
    claims: [{ id: "c1", text: "Dividends are taxed.", section_ids, tier: "federal", agency: null }],
    notes: [],
    unanswered: ["State levies are not yet loaded."],
  });
const sectionRow = { columns: ["section_id", "act_id", "section_no", "heading", "tier", "text"], rows: [["NTA-2025-s9", "NTA-2025", "9", "Dividends", "federal", "x".repeat(900)]] };

/** The tool message sent back to the model on the given chat call (0-based). */
const toolMessageOnCall = (i: number): ChatMessage | undefined =>
  (chatMock.mock.calls[i]?.[0] as ChatOptions).messages.find((m) => m.role === "tool");

beforeEach(() => {
  chatMock.mockReset();
  sqlMock.mockReset();
  sqlMock.mockResolvedValue(sectionRow);
});

describe("guardSql", () => {
  it("appends LIMIT 40 and caps larger limits", () => {
    expect(guardSql("SELECT act_id FROM taxmap.acts")).toEqual({ ok: true, sql: "SELECT act_id FROM taxmap.acts LIMIT 40" });
    expect(guardSql("SELECT act_id FROM taxmap.acts LIMIT 500")).toMatchObject({ sql: "SELECT act_id FROM taxmap.acts LIMIT 40" });
  });

  it("rejects non-SELECT, semicolons and other tables", () => {
    expect(guardSql("DELETE FROM taxmap.sections").ok).toBe(false);
    expect(guardSql("SELECT 1 FROM taxmap.sections; DROP VIEW taxmap.sections").ok).toBe(false);
    expect(guardSql("SELECT * FROM pokeapi.pikachu_types_table").ok).toBe(false);
    expect(guardSql("SELECT * FROM taxmap.sections WHERE text LIKE '%drop%'").ok).toBe(true);
  });
});

describe("research", () => {
  it("runs the tool loop, terminates on JSON, and collects every receipt", async () => {
    chatMock
      .mockResolvedValueOnce(toolTurn("run_sql", { sql: "SELECT section_no FROM taxmap.sections WHERE act_id = 'NTA-2025'" }))
      .mockResolvedValueOnce(toolTurn("get_sections", { section_ids: ["NTA-2025-s9"] }))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])));

    const r = await research(profile, "What taxes?", new InMemoryRunMemory());

    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(sqlMock).toHaveBeenCalledTimes(2);
    // a plain section search is rewritten to the standard columns and capped
    expect(sqlMock.mock.calls[0]?.[0]).toBe(
      "SELECT section_id, act_id, section_no, heading, tier, text FROM taxmap.sections WHERE act_id = 'NTA-2025' LIMIT 40",
    );
    const firstResult = JSON.parse(toolMessageOnCall(1)?.content ?? "{}");
    expect(firstResult.rows[0].snippet).toHaveLength(500);
    expect(r.draft.claims).toEqual([
      { id: "c1", text: "Dividends are taxed.", section_ids: ["NTA-2025-s9"], tier: "federal", agency: null },
    ]);
    expect(r.receipts.map((x) => x.receipt_id)).toHaveLength(3);
    expect(r.trace.filter((t) => t.kind === "tool_result")).toHaveLength(2);
    // later turns carry the memory summary rather than every earlier result
    const thirdCall = chatMock.mock.calls[2]?.[0] as ChatOptions;
    expect(thirdCall.messages[1]?.content).toContain("Already found");
    expect(thirdCall.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("returns a rejection to the model instead of running non-SELECT SQL", async () => {
    chatMock
      .mockResolvedValueOnce(toolTurn("run_sql", { sql: "DELETE FROM taxmap.sections" }))
      .mockResolvedValueOnce(textTurn(JSON.stringify({ claims: [], notes: [], unanswered: [] })));

    await research(profile, "q", new InMemoryRunMemory());

    expect(sqlMock).not.toHaveBeenCalled();
    expect(JSON.parse(toolMessageOnCall(1)?.content ?? "{}").error).toMatch(/Only SELECT/);
  });

  it("drops section_ids that never appeared in a tool result", async () => {
    chatMock
      .mockResolvedValueOnce(toolTurn("get_sections", { section_ids: ["NTA-2025-s9"] }))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9", "NTA-2025-s999"])));

    const r = await research(profile, "q", new InMemoryRunMemory());

    expect(r.draft.claims[0]?.section_ids).toEqual(["NTA-2025-s9"]);
    expect(r.draft.notes.join(" ")).toContain("c1:NTA-2025-s999");
  });

  it("fetches sections cited from snippets only and lets the model revise against the full text", async () => {
    chatMock
      .mockResolvedValueOnce(toolTurn("run_sql", { sql: "SELECT * FROM taxmap.sections" }))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])));

    const r = await research(profile, "q", new InMemoryRunMemory());

    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(sqlMock.mock.calls[1]?.[0]).toContain("WHERE section_id IN ('NTA-2025-s9')");
    const revision = chatMock.mock.calls[2]?.[0] as ChatOptions;
    expect(revision.tools).toBeUndefined();
    expect(revision.messages.at(-1)?.content).toContain("x".repeat(900)); // the full text, not the snippet
    expect(r.draft.claims[0]?.section_ids).toEqual(["NTA-2025-s9"]);
    expect(r.trace.some((t) => t.kind === "tool_call" && (t.detail as { by?: string }).by === "agent")).toBe(true);
  });

  it("drops claims whose sections were never read in full", async () => {
    sqlMock.mockResolvedValueOnce(sectionRow).mockResolvedValueOnce({ columns: sectionRow.columns, rows: [] });
    chatMock
      .mockResolvedValueOnce(toolTurn("run_sql", { sql: "SELECT * FROM taxmap.sections" }))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])));

    const r = await research(profile, "q", new InMemoryRunMemory());

    expect(r.draft.claims).toEqual([]);
    expect(r.draft.notes.join(" ")).toContain("not read in full with get_sections: c1:NTA-2025-s9");
  });

  it("sends no tools on the final turn and corrects a tool call made there", async () => {
    // turns 1-8 call tools (the 8th is ignored), the 9th is the correction reply
    chatMock.mockResolvedValueOnce(toolTurn("run_sql", { sql: "SELECT * FROM taxmap.sections" }));
    for (let i = 1; i < 8; i++) chatMock.mockResolvedValueOnce(toolTurn("get_sections", { section_ids: ["NTA-2025-s9"] }));
    chatMock.mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])));

    const r = await research(profile, "q", new InMemoryRunMemory());

    expect(chatMock).toHaveBeenCalledTimes(9);
    const finalTurn = chatMock.mock.calls[7]?.[0] as ChatOptions;
    expect(finalTurn.tools).toBeUndefined();
    expect(finalTurn.messages.some((m) => m.role === "tool" || m.tool_calls)).toBe(false);
    expect(finalTurn.messages[1]?.content).toContain("final turn");
    expect(r.draft.claims).toHaveLength(1);
  });

  it("sends one correction after an unparseable reply, then accepts the retry", async () => {
    chatMock
      .mockResolvedValueOnce(toolTurn("get_sections", { section_ids: ["NTA-2025-s9"] }))
      .mockResolvedValueOnce(textTurn("Here is what I found: dividends are taxed."))
      .mockResolvedValueOnce(textTurn("```json\n" + draftJson(["NTA-2025-s9"]) + "\n```"));

    const r = await research(profile, "q", new InMemoryRunMemory());

    expect(chatMock).toHaveBeenCalledTimes(3);
    const correction = (chatMock.mock.calls[2]?.[0] as ChatOptions).messages.at(-1);
    expect(correction?.role).toBe("user");
    expect(correction?.content).toMatch(/No JSON object found/);
    expect(r.draft.claims).toHaveLength(1);
    expect(r.receipts).toHaveLength(3);
  });
});
