import { beforeEach, describe, expect, it, vi } from "vitest";
import { areaParts, checklistAreas, covers, uncoveredAreas } from "../src/agents/checklist.js";
import { MAX_COVERAGE_TURNS, REVISION_MAX_SECTIONS, REVISION_TEXT_CHARS, areaScore, filterAbsenceNotes, research, revisionTexts } from "../src/agents/researcher.js";
import type { Claim, Profile } from "../src/agents/types.js";
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
  fixed_assets_band: "under_250m",
  employees: 3,
  has_premises: true,
  has_signage: true,
};
const claim = (text: string, section_ids: string[]): Claim => ({ id: "c", type: "obligation", text, section_ids, tier: "federal", agency: null });

describe("checklist coverage", () => {
  it("drops the PAYE area when there are no employees", () => {
    expect(checklistAreas(profile).map((a) => a.key)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(checklistAreas({ ...profile, employees: 0 }).map((a) => a.key)).toEqual(["a", "b", "d", "e", "f"]);
  });

  it("counts a claim by its wording or by the headings of the sections it cites, not by a shared Part", () => {
    const [a, , c, d, e] = checklistAreas(profile);
    expect(covers(claim("The shop must obtain a Tax ID.", []), a!)).toBe(true);
    expect(covers(claim("The shop must deduct tax from salaries.", ["NTAA-2025-s14"]), c!)).toBe(true); // heading "Pay As You Earn"
    const vatReturn = claim("The shop must file a return by the 21st.", ["NTAA-2025-s22"]); // in the shared RETURNS Part
    expect(covers(vatReturn, d!)).toBe(true); // heading "Returns for value added tax"
    expect(covers(vatReturn, c!)).toBe(false);
    expect(covers(vatReturn, e!)).toBe(false);
    expect(uncoveredAreas([vatReturn], profile).map((x) => x.key)).toEqual(["a", "b", "c", "e", "f"]);
  });

  it("finds each area's Parts in the map", () => {
    const parts = (k: string) => areaParts(checklistAreas(profile).find((a) => a.key === k)!).map((e) => `${e.act_id} ${e.part ?? e.chapter}`);
    expect(parts("a")).toEqual(["NTAA-2025 PART II – REGISTRATION"]);
    expect(parts("f")).toEqual(["NTA-2025 PART X – DEVELOPMENT LEVY", "NTA-2025 CHAPTER SEVEN SURCHARGE"]);
    expect(parts("d")).toContain("NTAA-2025 PART I – RETURNS");
  });
});

describe("revision input caps", () => {
  it("keeps the 8 most relevant sections, each cut to 1,500 characters", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      section_id: `NTAA-2025-s${i + 1}`,
      heading: i === 9 ? "Pay As You Earn" : "Other matter",
      text: (i === 3 ? "employer PAYE deduction " : "") + "x".repeat(2_000),
    }));
    const c = checklistAreas(profile).find((a) => a.key === "c")!;
    const kept = revisionTexts(rows, areaScore([c]));
    expect(REVISION_MAX_SECTIONS).toBe(8);
    expect(kept).toHaveLength(8);
    expect(kept.slice(0, 2).map((r) => r.section_id)).toEqual(["NTAA-2025-s10", "NTAA-2025-s4"]); // heading match outranks text
    expect(kept.every((r) => String(r.text).length <= REVISION_TEXT_CHARS + " [truncated]".length)).toBe(true);
  });

  it("drops the new absence phrases unless an unanswered entry matches", () => {
    const notes = [
      "No small-business threshold is present in the loaded data.",
      "PAYE is not covered by the sections read.",
      "The term is not defined.",
      "There is no definition of trader.",
      "No VAT rule is not present here.",
    ];
    expect(filterAbsenceNotes(notes, ["Checklist (c) Employer obligations (PAYE deduction and remittance): no claim."], profile)).toEqual([
      "PAYE is not covered by the sections read.",
    ]);
  });
});

describe("targeted coverage turns", () => {
  const receipt = { receipt_id: "r", decision_id: "d", requested_model: "m", routed_model: "m", provider: "p", label: "", tier: "", kind: "", input_tokens: 1, output_tokens: 1, latency_ms: 1, signed: true };
  const text = (content: string) => ({ message: { role: "assistant" as const, content }, receipt, raw_id: "x" });
  const tool = (name: string, args: unknown) => ({
    message: { role: "assistant" as const, content: null, tool_calls: [{ id: `t_${name}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] },
    receipt,
    raw_id: "x",
  });
  const draft = (claims: Array<{ text: string; ids: string[] }>, unanswered: string[] = []) =>
    JSON.stringify({ claims: claims.map((c, i) => ({ id: `c${i + 1}`, type: "obligation", text: c.text, section_ids: c.ids, tier: "federal", agency: null })), notes: [], unanswered });

  beforeEach(() => {
    chatMock.mockReset();
    sqlMock.mockReset();
    sqlMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT section_id, section_no, heading")) {
        return { columns: ["section_id", "section_no", "heading"], rows: [["NTAA-2025-s7", "7", "Issuance of Tax ID"]] };
      }
      const ids = [...sql.matchAll(/'((?:NTA|NTAA)-2025-s\d+)'/g)].map((m) => m[1] ?? "");
      return {
        columns: ["section_id", "act_id", "section_no", "heading", "tier", "text"],
        rows: (ids.length ? ids : ["NTA-2025-s4"]).map((id) => [id, id.replace(/-s\d+$/, ""), id.replace(/^.*-s/, ""), "h", "federal", `text of ${id}`]),
      };
    });
  });

  it("asks once per uncovered area (at most four), then revises, and reports the rest as unanswered with a reason", async () => {
    chatMock
      .mockResolvedValueOnce(tool("get_sections", { section_ids: ["NTA-2025-s4"] }))
      .mockResolvedValueOnce(text(draft([{ text: "Business profits are chargeable to income tax.", ids: ["NTA-2025-s4"] }]))) // covers (b) only
      .mockResolvedValueOnce(tool("get_sections", { section_ids: ["NTAA-2025-s7"] })) // (a)
      .mockResolvedValueOnce(text("I will look at PAYE.")) // (c): no tool call
      .mockResolvedValueOnce(text("Nothing to fetch.")) // (d)
      .mockResolvedValueOnce(text("Nothing to fetch.")) // (e)
      .mockResolvedValueOnce(
        text(draft([{ text: "Business profits are chargeable to income tax.", ids: ["NTA-2025-s4"] }, { text: "The shop must obtain a Tax ID.", ids: ["NTAA-2025-s7"] }])),
      );

    const r = await research(profile, "What taxes?", new InMemoryRunMemory());

    expect(MAX_COVERAGE_TURNS).toBe(4);
    expect(chatMock).toHaveBeenCalledTimes(2 + 4 + 1);
    const asks = chatMock.mock.calls.slice(2, 6).map((c) => (c[0] as ChatOptions).messages.at(-1)?.content ?? "");
    expect(asks[0]).toContain("Checklist area (a) Registration and tax identification is not covered by any claim");
    expect(asks[0]).toContain("PART II – REGISTRATION (s4-s9)");
    expect(asks[0]).toContain("NTAA-2025-s7 Issuance of Tax ID"); // the agent's own browse of the Part
    expect(asks.map((a) => /\(([a-f])\)/.exec(a)?.[1])).toEqual(["a", "c", "d", "e"]);
    const revise = chatMock.mock.calls[6]?.[0] as ChatOptions;
    expect(revise.tools).toBeUndefined();
    expect(revise.max_tokens).toBe(8000);
    expect(revise.messages[1]?.content).toContain("Digest of the tool results so far"); // not the raw tool results
    expect(revise.messages.some((m) => m.role === "tool")).toBe(false);
    expect(revise.messages.at(-1)?.content).toContain("text of NTAA-2025-s7");

    expect(r.draft.claims.map((c) => c.text)).toEqual(["Business profits are chargeable to income tax.", "The shop must obtain a Tax ID."]);
    expect(r.draft.unanswered).toEqual([
      expect.stringMatching(/^Checklist \(c\) Employer obligations .*: no claim after a targeted search of NTAA-2025/),
      expect.stringMatching(/^Checklist \(d\) VAT .*: no claim after a targeted search of/),
      expect.stringMatching(/^Checklist \(e\) Record keeping and returns: no claim after a targeted search of/),
      "Checklist (f) Any levy the Acts impose on businesses of this profile: not searched in a targeted turn (limit of 4 targeted turns reached).",
    ]);
  });

  it("never counts an unanswered entry as covering an area: those areas still get targeted turns", async () => {
    const earlier = ["PAYE remittance deadlines were not found.", "No VAT charging or filing rule was found.", "No record keeping rule was found.", "No levy was found."];
    const profitsOnly = draft([{ text: "Business profits are chargeable to income tax.", ids: ["NTA-2025-s4"] }], earlier);
    chatMock
      .mockResolvedValueOnce(tool("get_sections", { section_ids: ["NTA-2025-s4"] }))
      .mockResolvedValueOnce(text(profitsOnly)) // (b) by a claim; the unanswered entries for (c)-(f) do not count
      .mockResolvedValueOnce(text("Nothing to fetch.")) // (a)
      .mockResolvedValueOnce(text("Nothing to fetch.")) // (c)
      .mockResolvedValueOnce(text("Nothing to fetch.")) // (d)
      .mockResolvedValueOnce(text("Nothing to fetch.")) // (e)
      .mockResolvedValueOnce(text(profitsOnly));

    const r = await research(profile, "q", new InMemoryRunMemory());

    expect(chatMock).toHaveBeenCalledTimes(2 + 4 + 1);
    const asks = chatMock.mock.calls.slice(2, 6).map((c) => (c[0] as ChatOptions).messages.at(-1)?.content ?? "");
    expect(asks.map((a) => /\(([a-f])\)/.exec(a)?.[1])).toEqual(["a", "c", "d", "e"]);
    expect(asks[0]).toContain("An entry in unanswered does not count.");
    // the model's own entries are kept, and every area still without a claim gets the agent's reason too
    expect(r.draft.unanswered.slice(0, 4)).toEqual(earlier);
    expect(r.draft.unanswered.slice(4).map((u) => /^Checklist \(([a-f])\)/.exec(u)?.[1])).toEqual(["a", "c", "d", "e", "f"]);
    expect(r.draft.unanswered.at(-1)).toMatch(/not searched in a targeted turn \(limit of 4 targeted turns reached\)/);
  });

  it("sends one correction when the coverage revision is not valid JSON, and uses the corrected draft", async () => {
    const profits = { text: "Business profits are chargeable to income tax.", ids: ["NTA-2025-s4"] };
    chatMock
      .mockResolvedValueOnce(tool("get_sections", { section_ids: ["NTA-2025-s4"] }))
      .mockResolvedValueOnce(text(draft([profits])))
      .mockResolvedValueOnce(tool("get_sections", { section_ids: ["NTAA-2025-s7"] })) // (a)
      .mockResolvedValueOnce(text("Nothing to fetch.")) // (c)
      .mockResolvedValueOnce(text("Nothing to fetch.")) // (d)
      .mockResolvedValueOnce(text("Nothing to fetch.")) // (e)
      .mockResolvedValueOnce(text('{"claims": [{"id": "c1" "type": "obligation"}]')) // broken JSON
      .mockResolvedValueOnce(text(draft([profits, { text: "The shop must obtain a Tax ID.", ids: ["NTAA-2025-s7"] }])));

    const r = await research(profile, "q", new InMemoryRunMemory());

    expect(chatMock).toHaveBeenCalledTimes(2 + 4 + 2);
    const correction = (chatMock.mock.calls[7]?.[0] as ChatOptions).messages.at(-1)?.content ?? "";
    expect(correction).toMatch(/Invalid JSON/);
    expect(r.draft.claims.map((c) => c.text)).toContain("The shop must obtain a Tax ID.");
    expect(r.trace.some((t) => (t.detail as { phase?: string }).phase === "coverage_correction")).toBe(true);
  });

  it("drops a model note asserting an absence unless an unanswered entry matches it", async () => {
    const all = [
      { text: "The shop must register and obtain a Tax ID.", ids: ["NTAA-2025-s7"] },
      { text: "Its profits are chargeable to income tax.", ids: ["NTA-2025-s4"] },
      { text: "It must operate PAYE for its employees.", ids: ["NTAA-2025-s14"] },
      { text: "As a small business it need not file VAT returns.", ids: ["NTAA-2025-s22"] },
      { text: "It must keep books of account.", ids: ["NTAA-2025-s31"] },
      { text: "It does not pay the development levy.", ids: ["NTA-2025-s59"] },
    ];
    const withNotes = JSON.parse(draft(all, ["Lagos signage levy legislation is not loaded."])) as { notes: string[] };
    withNotes.notes = [
      "Small-business definitions are not loaded.", // no matching unanswered entry: dropped
      "State signage levy legislation is not loaded.", // matches the unanswered entry: kept
      "Assumes the shop sells goods, not services.", // not an absence claim: kept
    ];
    chatMock
      .mockResolvedValueOnce(tool("get_sections", { section_ids: all.map((c) => c.ids[0]) }))
      .mockResolvedValueOnce(text(JSON.stringify(withNotes)));

    const r = await research(profile, "q", new InMemoryRunMemory());

    expect(r.draft.notes).toEqual([
      "State signage levy legislation is not loaded.",
      "Assumes the shop sells goods, not services.",
      "Removed 1 note(s) saying something was not found or not loaded, with no matching unanswered entry.",
    ]);
  });

  it("retries a tool-free drafting call once at 16,000 tokens when the 8,000 cap fails", async () => {
    const all = [{ text: "Its profits are chargeable to income tax.", ids: ["NTA-2025-s4"] }];
    // the 12th turn is tool-free: reach it with 11 tool turns, each a different id set so none is a repeat
    chatMock.mockResolvedValueOnce(tool("get_sections", { section_ids: ["NTA-2025-s4"] }));
    for (let i = 0; i < 10; i++) chatMock.mockResolvedValueOnce(tool("get_sections", { section_ids: ["NTA-2025-s4", `NTA-2025-s${i + 10}`] }));
    chatMock
      .mockRejectedValueOnce(new Error('Meterless server error: HTTP 502 {"error":{"message":"/nemotron_empty_response"}}'))
      .mockResolvedValueOnce(text(draft(all, ["No Tax ID, PAYE, VAT, record keeping or levy rule was found."])));

    const r = await research(profile, "q", new InMemoryRunMemory(), { coverage: false });

    const calls = chatMock.mock.calls.map((c) => ({ opts: c[0] as ChatOptions, runtime: c[1] as { retries?: number; timeoutMs?: number } }));
    const finalTries = calls.slice(-2);
    expect(finalTries.map((c) => c.opts.max_tokens)).toEqual([8000, 16000]);
    expect(finalTries.map((c) => c.runtime.retries)).toEqual([0, 1]);
    expect(finalTries.map((c) => c.runtime.timeoutMs)).toEqual([300_000, 300_000]); // drafting turns get 300 s
    expect(calls[0]?.runtime.timeoutMs).toBe(150_000); // tool turns keep 150 s
    expect(r.trace.some((t) => (t.detail as { phase?: string }).phase === "draft_retry")).toBe(true);
    expect(r.draft.claims).toHaveLength(1);
  });

  it("makes no targeted turns when every area has a claim", async () => {
    const all = [
      { text: "The shop must register and obtain a Tax ID.", ids: ["NTAA-2025-s7"] },
      { text: "Its profits are chargeable to income tax.", ids: ["NTA-2025-s4"] },
      { text: "It must operate PAYE for its employees.", ids: ["NTAA-2025-s14"] },
      { text: "As a small business it need not file VAT returns.", ids: ["NTAA-2025-s22"] },
      { text: "It must keep books of account.", ids: ["NTAA-2025-s31"] },
      { text: "It does not pay the development levy.", ids: ["NTA-2025-s59"] },
    ];
    chatMock
      .mockResolvedValueOnce(tool("get_sections", { section_ids: all.map((c) => c.ids[0]) }))
      .mockResolvedValueOnce(text(draft(all)));
    const r = await research(profile, "q", new InMemoryRunMemory());
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(r.draft.unanswered).toEqual([]);
  });
});
