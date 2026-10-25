import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TURNS, REVISION_MAX_SECTIONS, REVISION_TEXT_CHARS, candidateTexts, drafterDigest, guardSql, research, sectionIdList } from "../src/agents/researcher.js";
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
  fixed_assets_band: "under_250m",
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

    const r = await research(profile, "What taxes?", new InMemoryRunMemory(), { coverage: false });

    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(sqlMock).toHaveBeenCalledTimes(2);
    // a plain section search is rewritten to the standard columns and capped
    expect(sqlMock.mock.calls[0]?.[0]).toBe(
      "SELECT section_id, act_id, section_no, heading, tier, text FROM taxmap.sections WHERE act_id = 'NTA-2025' LIMIT 40",
    );
    const firstResult = JSON.parse(toolMessageOnCall(1)?.content ?? "{}");
    expect(firstResult.rows[0].snippet).toHaveLength(500);
    expect(r.draft.claims).toEqual([
      { id: "c1", type: "obligation", text: "Dividends are taxed.", plain: "", section_ids: ["NTA-2025-s9"], tier: "federal", agency: null },
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

    await research(profile, "q", new InMemoryRunMemory(), { coverage: false });

    expect(sqlMock).not.toHaveBeenCalled();
    expect(JSON.parse(toolMessageOnCall(1)?.content ?? "{}").error).toMatch(/Only SELECT/);
  });

  it("drops section_ids that never appeared in a tool result", async () => {
    chatMock
      .mockResolvedValueOnce(toolTurn("get_sections", { section_ids: ["NTA-2025-s9"] }))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9", "NTA-2025-s999"])));

    const r = await research(profile, "q", new InMemoryRunMemory(), { coverage: false });

    expect(r.draft.claims[0]?.section_ids).toEqual(["NTA-2025-s9"]);
    expect(r.draft.notes.join(" ")).toContain("c1:NTA-2025-s999");
  });

  it("fetches sections cited from snippets only and lets the model revise against the full text", async () => {
    chatMock
      .mockResolvedValueOnce(toolTurn("run_sql", { sql: "SELECT * FROM taxmap.sections" }))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])));

    const r = await research(profile, "q", new InMemoryRunMemory(), { coverage: false });

    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(sqlMock.mock.calls[1]?.[0]).toContain("WHERE section_id IN ('NTA-2025-s9')");
    const revision = chatMock.mock.calls[2]?.[0] as ChatOptions;
    expect(revision.tools).toBeUndefined();
    expect(revision.messages.at(-1)?.content).toContain("x".repeat(900)); // the full text, not the snippet
    // the revision turn has the digest in its context, and its own message carries the texts (not shown twice)
    expect(revision.messages[1]?.content).toContain("Digest of the tool results so far");
    expect(revision.messages[1]?.content).not.toContain("Full text of the sections most likely to be cited");
    expect(r.draft.claims[0]?.section_ids).toEqual(["NTA-2025-s9"]);
    expect(r.trace.some((t) => t.kind === "tool_call" && (t.detail as { by?: string }).by === "agent")).toBe(true);
  });

  it("drops claims whose sections were never read in full", async () => {
    sqlMock.mockResolvedValueOnce(sectionRow).mockResolvedValueOnce({ columns: sectionRow.columns, rows: [] });
    chatMock
      .mockResolvedValueOnce(toolTurn("run_sql", { sql: "SELECT * FROM taxmap.sections" }))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])));

    const r = await research(profile, "q", new InMemoryRunMemory(), { coverage: false });

    expect(r.draft.claims).toEqual([]);
    expect(r.draft.notes.join(" ")).toContain("not read in full with get_sections: c1:NTA-2025-s9");
  });

  it("sends no tools on the final turn and corrects a tool call made there", async () => {
    // turns 1..MAX_TURNS call tools (the last is ignored); the one after is the correction reply
    chatMock.mockResolvedValueOnce(toolTurn("run_sql", { sql: "SELECT * FROM taxmap.sections" }));
    // a different id set each turn, so get_sections repeat suppression does not end the run early
    for (let i = 1; i < MAX_TURNS; i++) chatMock.mockResolvedValueOnce(toolTurn("get_sections", { section_ids: ["NTA-2025-s9", `NTA-2025-s${i}`] }));
    chatMock.mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])));

    const r = await research(profile, "q", new InMemoryRunMemory(), { coverage: false });

    expect(chatMock).toHaveBeenCalledTimes(MAX_TURNS + 1);
    const finalTurn = chatMock.mock.calls[MAX_TURNS - 1]?.[0] as ChatOptions;
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

    const r = await research(profile, "q", new InMemoryRunMemory(), { coverage: false });

    expect(chatMock).toHaveBeenCalledTimes(3);
    const correction = (chatMock.mock.calls[2]?.[0] as ChatOptions).messages.at(-1);
    expect(correction?.role).toBe("user");
    expect(correction?.content).toMatch(/No JSON object found/);
    expect(r.draft.claims).toHaveLength(1);
    expect(r.receipts).toHaveLength(3);
  });
});

describe("drafting context: a digest instead of raw tool results", () => {
  const read = (n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`NTA-2025-s${i + 1}`, { heading: `Heading ${i + 1}`, text: `S${i + 1} ` + "a".repeat(3_000), act_id: "NTA-2025", section_no: String(i + 1) }]),
    );

  it("gives each query's SQL and row count, and each section read its id, heading and first 300 characters", () => {
    const d = drafterDigest(
      [
        { query: "SELECT section_id FROM taxmap.sections WHERE lower(text) LIKE '%vat%'", rows: 7 },
        { query: "SELECT x FROM taxmap.sections WHERE section_id IN ('NTA-2025-s1')", rows: 1 },
        { query: `SELECT ${"y, ".repeat(200)}z FROM taxmap.sections`, rows: 0 },
      ],
      read(2),
    );
    expect(d).toContain("- SELECT section_id FROM taxmap.sections WHERE lower(text) LIKE '%vat%' -> 7 rows");
    expect(d).toContain("-> 1 row\n");
    expect(d).toContain("-> 0 rows");
    expect(d).toMatch(/y, y, [\s\S]*…\s*-> 0 rows/); // a long SQL is cut at 300 characters
    expect(d).toContain(`- NTA-2025-s1 (Heading 1): S1 ${"a".repeat(297)}\n`); // 300 characters of text, no more
    expect(d).not.toContain("a".repeat(298));
    expect(drafterDigest([], {})).toContain("- none");
  });

  it("passes at most 8 candidate sections at 1,500 characters, the ones the draft cites first", () => {
    const rows = candidateTexts(read(12), ["NTA-2025-s11", "NTA-2025-s12"], () => 0);
    expect(rows).toHaveLength(REVISION_MAX_SECTIONS);
    expect(REVISION_MAX_SECTIONS).toBe(8);
    expect(rows.slice(0, 2).map((r) => r.section_id)).toEqual(["NTA-2025-s11", "NTA-2025-s12"]);
    expect(rows.every((r) => String(r.text).length <= REVISION_TEXT_CHARS + " [truncated]".length)).toBe(true);
    expect(String(rows[0]?.text)).toMatch(/ \[truncated\]$/);
  });

  it("builds the final turn from the digest and eight cut texts, with no raw tool results", async () => {
    sqlMock.mockImplementation(async (sql: string) => {
      const ids = [...sql.matchAll(/'(NTA-2025-s\d+)'/g)].map((m) => m[1] ?? "");
      return {
        columns: ["section_id", "act_id", "section_no", "heading", "tier", "text"],
        rows: ids.map((id) => [id, "NTA-2025", id.replace(/^.*-s/, ""), `Heading of ${id}`, "federal", `${id} ` + "b".repeat(3_000)]),
      };
    });
    chatMock.mockResolvedValueOnce(toolTurn("run_sql", { sql: "SELECT * FROM taxmap.sections WHERE lower(text) LIKE '%vat%'" }));
    // ten different sections read, one per turn, so more than eight are candidates by the final turn
    for (let i = 1; i < MAX_TURNS - 1; i++) chatMock.mockResolvedValueOnce(toolTurn("get_sections", { section_ids: [`NTA-2025-s${i}`] }));
    chatMock.mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s10"])));

    await research(profile, "q", new InMemoryRunMemory(), { coverage: false });

    const final = chatMock.mock.calls[MAX_TURNS - 1]?.[0] as ChatOptions;
    expect(final.tools).toBeUndefined();
    expect(final.messages.some((m) => m.role === "tool" || m.tool_calls)).toBe(false);
    const content = String(final.messages[1]?.content);
    expect(content).not.toContain("Excerpts of the sections seen");
    expect(content).toContain("Digest of the tool results so far");
    expect(content).toContain("- SELECT section_id, act_id, section_no, heading, tier, text FROM taxmap.sections WHERE lower(text) LIKE '%vat%' LIMIT 40 -> 0 rows");
    expect(content).toContain("- SELECT section_id, act_id, section_no, heading, tier, text FROM taxmap.sections WHERE section_id IN ('NTA-2025-s5') -> 1 row");
    // every section read is in the digest at 300 characters
    for (let i = 1; i < MAX_TURNS - 1; i++) expect(content).toContain(`- NTA-2025-s${i} (Heading of NTA-2025-s${i}): NTA-2025-s${i} ${"b".repeat(300 - `NTA-2025-s${i} `.length)}\n`);
    // and at most eight of them again, in full to 1,500 characters
    const block = /most likely to be cited \(at most 8, first 1500 characters each\):\n(.*)/.exec(content)?.[1] ?? "[]";
    const texts = JSON.parse(block) as Array<{ section_id: string; text: string }>;
    expect(texts).toHaveLength(8);
    expect(texts.every((t) => t.text.length <= REVISION_TEXT_CHARS + " [truncated]".length)).toBe(true);
    expect(content).not.toContain("b".repeat(REVISION_TEXT_CHARS + 1));
  });
});

describe("get_sections arguments", () => {
  it("reads section_ids sent as a string, as JSON or as a bracketed list", async () => {
    expect(sectionIdList('["NTA-2025-s9", "NTAA-2025-s22"]')).toEqual(["NTA-2025-s9", "NTAA-2025-s22"]);
    expect(sectionIdList("[NTA-2025-s9, NTAA-2025-s22]")).toEqual(["NTA-2025-s9", "NTAA-2025-s22"]);
    expect(sectionIdList("NTA-2025-s9, TLA-1998-sch-III-1")).toEqual(["NTA-2025-s9", "TLA-1998-sch-III-1"]);
    expect(sectionIdList(["NTA-2025-s9"])).toEqual(["NTA-2025-s9"]);
    expect(sectionIdList(5)).toBe(5);
    chatMock
      .mockResolvedValueOnce(toolTurn("get_sections", { section_ids: "[NTA-2025-s9]" }))
      .mockResolvedValueOnce(textTurn(draftJson(["NTA-2025-s9"])));
    const r = await research(profile, "q", new InMemoryRunMemory(), { coverage: false });
    expect(sqlMock.mock.calls[0]?.[0]).toContain("WHERE section_id IN ('NTA-2025-s9')");
    expect(r.draft.claims[0]?.section_ids).toEqual(["NTA-2025-s9"]);
  });
});
