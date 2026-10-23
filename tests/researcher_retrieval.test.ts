import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalSql, filterNotes, research, researcherSystemPrompt } from "../src/agents/researcher.js";
import { findPart, tocEntries } from "../src/agents/toc.js";
import type { Profile } from "../src/agents/types.js";
import { runSql } from "../src/data/zetaris.js";
import { InMemoryRunMemory } from "../src/engines/hmem/index.js";
import { chat, type ChatOptions } from "../src/providers/meterless.js";

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
const receipt = { receipt_id: "r", decision_id: "d", requested_model: "m", routed_model: "m", provider: "p", label: "", tier: "", kind: "", input_tokens: 1, output_tokens: 1, latency_ms: 1, signed: true };
const toolTurn = (name: string, args: unknown) => ({
  message: { role: "assistant" as const, content: null, tool_calls: [{ id: `c_${name}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] },
  receipt,
  raw_id: "x",
});
const textTurn = (content: string) => ({ message: { role: "assistant" as const, content }, receipt, raw_id: "x" });
const emptyDraft = JSON.stringify({ claims: [], notes: [], unanswered: [] });
const sentOn = (i: number) => chatMock.mock.calls[i]?.[0] as ChatOptions;

beforeEach(() => {
  chatMock.mockReset();
  sqlMock.mockReset();
  sqlMock.mockResolvedValue({ columns: ["section_id", "section_no", "heading"], rows: [["NTA-2025-s143", "143", "Imposition of VAT"]] });
});

describe("Map of the Acts", () => {
  it("is built from sections.json and inserted into the system prompt", () => {
    const prompt = researcherSystemPrompt();
    expect(prompt).toContain("## Map of the Acts");
    expect(prompt).not.toContain("{{MAP_OF_ACTS}}");
    expect(prompt).toContain("NTA-2025: Nigeria Tax Act, 2025");
    expect(prompt).toContain("s143-s150 | chapter: CHAPTER SIX VALUE ADDED TAX | part: PART I – IMPOSITION OF VALUE ADDED TAX");
    expect(prompt).toContain("chapter: (none) | part: PART I – OBJECTIVE AND APPLICATION"); // NRSEA has no chapters
    expect(tocEntries()).toHaveLength(50);
  });

  it("resolves parts by full heading or label, and refuses ambiguous ones", () => {
    const toc = tocEntries();
    expect(findPart(toc, "NTA-2025", "CHAPTER SIX", "PART II")).toMatchObject({ ok: true, entry: { first: 151, last: 157 } });
    expect(findPart(toc, "NRSEA-2025", "(none)", "PART V - FINANCIAL PROVISIONS")).toMatchObject({ ok: true, entry: { first: 22 } });
    expect(findPart(toc, "NTA-2025", undefined, "PART I")).toMatchObject({ ok: false });
  });
});

describe("browse_part", () => {
  it("queries one part's sections without text and returns them to the model", async () => {
    chatMock
      .mockResolvedValueOnce(toolTurn("browse_part", { act_id: "NTA-2025", chapter: "CHAPTER SIX", part: "PART I" }))
      .mockResolvedValueOnce(textTurn(emptyDraft));

    await research(profile, "q", new InMemoryRunMemory());

    expect(sqlMock).toHaveBeenCalledWith(
      "SELECT section_id, section_no, heading FROM taxmap.sections WHERE act_id = 'NTA-2025' AND " +
        "chapter = 'CHAPTER SIX VALUE ADDED TAX' AND part = 'PART I – IMPOSITION OF VALUE ADDED TAX' ORDER BY CAST(section_no AS INT)",
    );
    const result = JSON.parse(sentOn(1).messages.find((m) => m.role === "tool")?.content ?? "{}");
    expect(result.sections).toEqual([{ section_id: "NTA-2025-s143", section_no: "143", heading: "Imposition of VAT" }]);
  });

  it("returns an error for a part not in the map, without querying", async () => {
    chatMock
      .mockResolvedValueOnce(toolTurn("browse_part", { act_id: "NTA-2025", chapter: "CHAPTER SIX", part: "PART IX" }))
      .mockResolvedValueOnce(textTurn(emptyDraft));

    await research(profile, "q", new InMemoryRunMemory());

    expect(sqlMock).not.toHaveBeenCalled();
    expect(sentOn(1).messages.find((m) => m.role === "tool")?.content).toMatch(/No such part/);
  });
});

describe("repeat suppression", () => {
  it("treats reordered OR terms and ILIKE as the same query", () => {
    expect(canonicalSql("SELECT a FROM taxmap.sections WHERE lower(text) LIKE '%vat%' OR heading ILIKE '%levy%' LIMIT 40")).toBe(
      canonicalSql("select a  from taxmap.sections where heading like '%levy%' or text like '%vat%'"),
    );
  });

  it("answers repeats from the earlier result and moves to the final turn after two", async () => {
    chatMock
      .mockResolvedValueOnce(toolTurn("run_sql", { sql: "SELECT * FROM taxmap.sections WHERE lower(text) LIKE '%vat%' OR lower(text) LIKE '%levy%'" }))
      .mockResolvedValueOnce(toolTurn("run_sql", { sql: "SELECT * FROM taxmap.sections WHERE lower(text) LIKE '%levy%' OR lower(text) LIKE '%vat%'" }))
      .mockResolvedValueOnce(toolTurn("run_sql", { sql: "select *  from taxmap.sections where text ilike '%vat%' or text ilike '%levy%' limit 10" }))
      .mockResolvedValueOnce(textTurn(emptyDraft));

    const r = await research(profile, "q", new InMemoryRunMemory());

    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sentOn(2).messages.find((m) => m.role === "tool")?.content).toMatch(/^ALREADY RUN; use browse_part or get_sections instead\n\{/);
    expect(chatMock).toHaveBeenCalledTimes(4);
    expect(sentOn(3).tools).toBeUndefined(); // turn 4 is the final turn, well before MAX_TURNS
    expect(sentOn(3).messages[1]?.content).toContain("final turn");
    expect(r.trace.filter((t) => (t.detail as { repeat?: number }).repeat)).toHaveLength(2);
  });
});

describe("get_sections repeats and sections_read", () => {
  it("answers a repeated id set (in any order) from the earlier result and returns sections_read", async () => {
    sqlMock.mockResolvedValue({
      columns: ["section_id", "act_id", "section_no", "heading", "tier", "text"],
      rows: [
        ["NTA-2025-s143", "NTA-2025", "143", "Imposition of VAT", "federal", "There is imposed a tax."],
        ["NTA-2025-s147", "NTA-2025", "147", "Rate of VAT", "federal", "at the rate of 7.5%"],
      ],
    });
    chatMock
      .mockResolvedValueOnce(toolTurn("get_sections", { section_ids: ["NTA-2025-s143", "NTA-2025-s147"] }))
      .mockResolvedValueOnce(toolTurn("get_sections", { section_ids: ["NTA-2025-s147", "NTA-2025-s143", "NTA-2025-s147"] }))
      .mockResolvedValueOnce(textTurn(emptyDraft));

    const r = await research(profile, "q", new InMemoryRunMemory());

    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sentOn(2).messages.find((m) => m.role === "tool")?.content).toMatch(/^ALREADY RUN; use browse_part or get_sections instead\n/);
    expect(r.sections_read["NTA-2025-s147"]).toEqual({ heading: "Rate of VAT", text: "at the rate of 7.5%", act_id: "NTA-2025", section_no: "147" });
    expect(Object.keys(r.sections_read).sort()).toEqual(["NTA-2025-s143", "NTA-2025-s147"]);
  });
});

describe("note filtering", () => {
  it("expands ranges with any dash against the Act's section list", () => {
    const read = new Set(["NTA-2025-s143", "NTA-2025-s144", "NTA-2025-s145"]);
    expect(
      filterNotes(
        [
          "Read NTA-2025 s143-s145 in full.",
          "Read s143–s145.", // no Act named: passes if some Act has the whole range read
          "Read NTA-2025 s143‑s150.",
          "Read NTAA-2025 s143-s145.",
        ],
        read,
      ),
    ).toEqual(["Read NTA-2025 s143-s145 in full.", "Read s143–s145.", "note removed: unread section", "note removed: unread section"]);
  });

  it("replaces notes naming a section that was not read in full, including non-ASCII hyphens", () => {
    const fetched = new Set(["NTAA-2025-s22"]);
    expect(
      filterNotes(["Supported by NTAA-2025-s22.", "Claim c2 removed: NTA‑2025‑s59 was not read.", "No section named."], fetched),
    ).toEqual(["Supported by NTAA-2025-s22.", "note removed: unread section", "No section named."]);
  });

  it("is applied to the model's notes in the final draft", async () => {
    chatMock.mockResolvedValueOnce(
      textTurn(JSON.stringify({ claims: [], notes: ["NTA-2025-s59 does not apply."], unanswered: [] })),
    );
    const r = await research(profile, "q", new InMemoryRunMemory());
    expect(r.draft.notes).toEqual(["note removed: unread section"]);
  });
});
