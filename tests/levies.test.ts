import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { covers, checklistAreas } from "../src/agents/checklist.js";
import { collectorFor, NRS, SCHEDULE_COLLECTOR_SECTION } from "../src/agents/collector.js";
import { AMOUNT_REASON, critique, criticSystemPrompt, statesLevyAmount } from "../src/agents/critic.js";
import { glossary, matchDefinitions } from "../src/agents/glossary.js";
import { itemHeading, itemLabel, levies, statesAmount, type LevyItem } from "../src/agents/levies.js";
import { levySteer, research, researcherSystemPrompt } from "../src/agents/researcher.js";
import type { Claim, Profile, SectionRead } from "../src/agents/types.js";
import { runSql } from "../src/data/zetaris.js";
import { InMemoryRunMemory } from "../src/engines/hmem/index.js";
import { InMemoryWorldModel } from "../src/engines/world_model/index.js";
import { chat, type ChatMessage, type ChatOptions } from "../src/providers/meterless.js";
import { lawRef, splitLawId } from "../public/lawtext.js";

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

const json = <T>(f: string): T => JSON.parse(readFileSync(new URL(`../data/statutes/${f}`, import.meta.url), "utf-8")) as T;
const items = json<LevyItem[]>("levies.json");
const acts = json<Array<{ act_id: string; source_sha256: string; section_count: number; year: number }>>("acts.json");
const sections = json<Array<{ section_id: string; act_id: string; heading: string; text: string; tier: string }>>("sections.json");
const LGA_TITLE = "Taxes and levies to be collected by the local government";

let n = 0;
const receipt = () => ({ receipt_id: `r${++n}`, decision_id: "d", requested_model: "m", routed_model: "nvidia/nemotron", provider: "nvidia", label: "", tier: "A", kind: "cloud", input_tokens: 1, output_tokens: 1, latency_ms: 1, signed: true });
const toolTurn = (name: string, args: unknown) => ({
  message: { role: "assistant" as const, content: null, tool_calls: [{ id: `call_${name}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] },
  receipt: receipt(),
  raw_id: "x",
});
const textTurn = (body: unknown) => ({ message: { role: "assistant" as const, content: typeof body === "string" ? body : JSON.stringify(body) }, receipt: receipt(), raw_id: "x" });

const LEVY_COLUMNS = ["item_id", "act_id", "part", "part_title", "tier", "item_no", "text"];
const levyResult = (...ids: string[]) => ({
  columns: LEVY_COLUMNS,
  rows: ids.map((id) => {
    const i = levies().get(id) as LevyItem;
    return [i.item_id, i.act_id, i.part, i.part_title, i.tier, i.item_no, i.text];
  }),
});
const claim = (text: string, section_ids: string[], plain = ""): Claim => ({ id: "c1", type: "obligation", text, plain, section_ids, tier: "federal", agency: null });

beforeEach(() => {
  chatMock.mockReset();
  sqlMock.mockReset();
});

describe("parser: the Taxes and Levies (Approved List for Collection) Act 1998", () => {
  it("lists 8, 11 and 20 items in Parts I, II and III, numbered in order, with the tier s. 1(1) gives each Part", () => {
    for (const [part, count, tier] of [["I", 8, "federal"], ["II", 11, "state"], ["III", 20, "lga"]] as const) {
      const mine = items.filter((i) => i.part === part);
      expect(mine, part).toHaveLength(count);
      expect(mine.map((i) => i.item_no)).toEqual(Array.from({ length: count }, (_, k) => String(k + 1)));
      expect(new Set(mine.map((i) => i.tier))).toEqual(new Set([tier]));
      expect(mine.map((i) => i.item_id)).toEqual(mine.map((i) => `TLA-1998-sch-${part}-${i.item_no}`));
    }
    expect(items).toHaveLength(39);
  });

  it("keeps each Part's own heading and every record's provenance", () => {
    const titles = Object.fromEntries(items.map((i) => [i.part, i.part_title]));
    expect(titles).toEqual({
      I: "Taxes to be collected by the Federal Government",
      II: "Taxes and levies to be collected by the State Government",
      III: LGA_TITLE,
    });
    const act = acts.find((a) => a.act_id === "TLA-1998");
    expect(act).toMatchObject({ year: 1998, section_count: 5 });
    for (const i of items) {
      expect(i).toMatchObject({ act_id: "TLA-1998", source_file: "other/Nigeria_8_NigeriaTaxesLevies1998.pdf", source_sha256: act?.source_sha256 });
      expect(i.page).toBeGreaterThanOrEqual(2);
    }
    expect(act?.source_sha256).toBe("F2693F35B511672AF30BDE5F10680726C221DD55B07270EF932E00AE28053E3E");
  });

  it("keeps item text verbatim, with sub-items and figures inside their item", () => {
    const at = (id: string) => levies().get(id)?.text;
    expect(at("TLA-1998-sch-III-20")).toBe("Signboard and advertisement permit fees.");
    expect(at("TLA-1998-sch-III-1")).toBe("Shops and, kiosks rates."); // as printed
    expect(at("TLA-1998-sch-I-8")).toBe(
      "Personal income tax in respect of— (a) members of the armed forces of the Federation; (b) members of the Nigeria Police Force; (c) Residents of the Federal Capital Territory, Abuja; and (d) staff of the Ministry of Foreign Affairs and non-resident individuals.",
    );
    expect(at("TLA-1998-sch-II-7")).toContain("(i) N10,000 for registration; and (ii) N5,000 per annum for renewal of registration");
    expect(levies().get("TLA-1998-sch-I-8")?.page).toBe(2); // the item starts on page 2 and runs onto page 3
    expect(levies().get("TLA-1998-sch-III-15")?.page).toBe(4);
  });

  it("parses the Act's five sections, federal tier, and none of the Schedule into sections.json", () => {
    const tla = sections.filter((s) => s.act_id === "TLA-1998");
    expect(tla.map((s) => [s.section_id, s.heading])).toEqual([
      ["TLA-1998-s1", "Responsibility for collecting certain taxes, and levies, etc."],
      ["TLA-1998-s2", "Assessment and collection of taxes"],
      ["TLA-1998-s3", "Offences"],
      ["TLA-1998-s4", "Interpretation"],
      ["TLA-1998-s5", "Citation"],
    ]);
    expect(new Set(tla.map((s) => s.tier))).toEqual(new Set(["federal"]));
    expect(tla[0]?.text).toContain("the Federal Government, State Government and local government shall be responsible for collecting the taxes and levies listed in Part I, Part II and Part III of the Schedule to this Act, respectively.");
    expect(tla.some((s) => /Signboard|Tenement rates/.test(s.text))).toBe(false);
  });
});

describe("list_levies", () => {
  it("returns item_id, part, item_no and text for one tier, and counts the items as read", async () => {
    sqlMock.mockResolvedValue(levyResult("TLA-1998-sch-III-1", "TLA-1998-sch-III-20"));
    chatMock
      .mockResolvedValueOnce(toolTurn("list_levies", { tier: "lga" }))
      .mockResolvedValueOnce(textTurn({ claims: [claim("The Ikeja Local Government may collect signboard and advertisement permit fees.", ["TLA-1998-sch-III-20"])], notes: [], unanswered: [] }));

    const r = await research(profile, "What levies apply?", new InMemoryRunMemory(), { coverage: false });

    expect(sqlMock.mock.calls[0]?.[0]).toBe(
      "SELECT item_id, act_id, part, part_title, tier, item_no, text FROM taxmap.levies WHERE tier = 'lga' ORDER BY CAST(item_no AS INT)",
    );
    const tool = (chatMock.mock.calls[1]?.[0] as ChatOptions).messages.find((m: ChatMessage) => m.role === "tool");
    const content = JSON.parse(String(tool?.content)) as { tier: string; part_title: string; items: Array<Record<string, unknown>> };
    expect(content.tier).toBe("lga");
    expect(content.part_title).toBe(LGA_TITLE);
    expect(content.items).toEqual([
      { item_id: "TLA-1998-sch-III-1", part: "III", item_no: "1", text: "Shops and, kiosks rates." },
      { item_id: "TLA-1998-sch-III-20", part: "III", item_no: "20", text: "Signboard and advertisement permit fees." },
    ]);
    // read in full: the citation survives, with the item text kept for the Critic
    expect(r.draft.claims[0]?.section_ids).toEqual(["TLA-1998-sch-III-20"]);
    expect(r.sections_read["TLA-1998-sch-III-20"]).toEqual({
      heading: `Schedule, Part III, item 20 (${LGA_TITLE})`,
      text: "Signboard and advertisement permit fees.",
      act_id: "TLA-1998",
      section_no: "20",
    });
  });

  it("rejects a tier that is not federal, state or lga", async () => {
    chatMock.mockResolvedValueOnce(toolTurn("list_levies", { tier: "Lagos" })).mockResolvedValueOnce(textTurn({ claims: [], notes: [], unanswered: [] }));
    await research(profile, "q", new InMemoryRunMemory(), { coverage: false });
    expect(sqlMock).not.toHaveBeenCalled();
    const tool = (chatMock.mock.calls[1]?.[0] as ChatOptions).messages.find((m: ChatMessage) => m.role === "tool");
    expect(String(tool?.content)).toContain("list_levies needs tier: federal, state or lga.");
  });
});

describe("get_sections resolves Schedule item_ids from taxmap.levies", () => {
  it("fetches sections from taxmap.sections and items from taxmap.levies in one call", async () => {
    sqlMock.mockImplementation(async (sql: string) =>
      sql.includes("taxmap.levies")
        ? levyResult("TLA-1998-sch-II-7")
        : { columns: ["section_id", "act_id", "section_no", "heading", "tier", "text"], rows: [["TLA-1998-s1", "TLA-1998", "1", "Responsibility", "federal", "(1) ..."]] },
    );
    chatMock
      .mockResolvedValueOnce(toolTurn("get_sections", { section_ids: ["TLA-1998-s1", "TLA-1998-sch-II-7"] }))
      .mockResolvedValueOnce(textTurn({ claims: [], notes: [], unanswered: [] }));

    const r = await research(profile, "q", new InMemoryRunMemory(), { coverage: false });

    expect(sqlMock.mock.calls.map((c) => c[0])).toEqual([
      "SELECT section_id, act_id, section_no, heading, tier, text FROM taxmap.sections WHERE section_id IN ('TLA-1998-s1')",
      "SELECT item_id, act_id, part, part_title, tier, item_no, text FROM taxmap.levies WHERE item_id IN ('TLA-1998-sch-II-7')",
    ]);
    expect(Object.keys(r.sections_read).sort()).toEqual(["TLA-1998-s1", "TLA-1998-sch-II-7"]);
    expect(r.sections_read["TLA-1998-sch-II-7"]?.heading).toBe("Schedule, Part II, item 7 (Taxes and levies to be collected by the State Government)");
    expect(r.sections_read["TLA-1998-sch-II-7"]?.text).toContain("Business premises registration fee in respect of—");
  });

  it("rejects ids that are neither sections nor Schedule items", async () => {
    chatMock
      .mockResolvedValueOnce(toolTurn("get_sections", { section_ids: ["TLA-1998-sch-IV-1"] }))
      .mockResolvedValueOnce(textTurn({ claims: [], notes: [], unanswered: [] }));
    await research(profile, "q", new InMemoryRunMemory(), { coverage: false });
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe("Researcher prompt", () => {
  it("tells the model to use list_levies for area (f), cite item_ids, say 'may collect' and state no amount", () => {
    const p = researcherSystemPrompt();
    expect(p).toContain("`list_levies(tier)`");
    expect(p).toContain("for checklist area (f), and for any question about State or local levies");
    expect(p).toContain('says only that the authority "may collect" the named levy');
    expect(p).toContain("Never state an amount from `TLA-1998`.");
    expect(p).toContain("(f) Any levy the Acts impose on businesses of this profile. This includes the State and local government levies");
    expect(p).not.toContain("State or LGA legislation is not yet loaded");
  });

  it("steers a business with signage or premises to Part III, without naming an item number", () => {
    const steer = levySteer(profile).join(" ");
    expect(steer).toContain('Call list_levies with tier "lga" and check Part III');
    expect(steer).toContain("permit and premises items");
    expect(steer).toContain("signage and business premises");
    expect(steer).not.toMatch(/item\s+\d|sch-|TLA-1998-|signboard|tenement|kiosk/i);
    expect(levySteer({ ...profile, has_premises: false }).join(" ")).toContain("This business has signage.");
    expect(levySteer({ ...profile, has_signage: false, has_premises: false })).toEqual([]);
  });

  it("counts a 'may collect' claim on a Schedule item towards checklist area (f)", () => {
    const f = checklistAreas(profile).find((a) => a.key === "f");
    expect(f?.levies).toBe(true);
    expect(covers(claim("The Ikeja Local Government may collect signboard and advertisement permit fees.", ["TLA-1998-sch-III-20"]), f!)).toBe(true);
  });
});

describe("collector: the Schedule Part outranks the keyword rules", () => {
  it("puts Part I federal, Part II with the State and Part III with the local government", () => {
    expect(collectorFor(claim("The Lagos State Internal Revenue Service may collect road taxes.", ["TLA-1998-sch-II-6"]), profile)).toMatchObject({
      tier: "state",
      authority: "Lagos State Internal Revenue Service",
      section_id: SCHEDULE_COLLECTOR_SECTION,
    });
    const lga = collectorFor(claim("The Ikeja Local Government may collect signboard and advertisement permit fees.", ["TLA-1998-sch-III-20"]), profile);
    expect(lga).toMatchObject({ tier: "lga", authority: "Ikeja Local Government", section_id: "TLA-1998-s1" });
    expect(lga.basis).toBe(
      "Taxes and Levies (Approved List for Collection) Act 1998, s. 1(1): the local government is responsible for collecting the taxes and levies listed in Part III of the Schedule, and this line cites an item in Part III, so it goes to the Ikeja Local Government.",
    );
    expect(collectorFor(claim("The Federal Government may collect companies income tax.", ["TLA-1998-sch-I-1"]), profile)).toMatchObject({ tier: "federal", authority: NRS });
  });

  it("wins over the wording: an income tax line on Part I stays federal, a withholding line on Part II goes to the State", () => {
    // keyword rules alone would send personal income tax for a sole proprietor to the State...
    expect(collectorFor(claim("Personal income tax is charged.", []), profile).tier).toBe("state");
    expect(collectorFor(claim("Personal income tax is charged.", ["TLA-1998-sch-I-8"]), profile).tier).toBe("federal");
    // ...and withholding tax to the Nigeria Revenue Service
    expect(collectorFor(claim("Withholding tax applies.", []), profile).tier).toBe("federal");
    expect(collectorFor(claim("Withholding tax applies.", ["NTA-2025-s9", "TLA-1998-sch-II-2"]), profile).tier).toBe("state");
    // and over a company profile and the claim's own tier
    expect(collectorFor(claim("The local government may collect tenement rates.", ["TLA-1998-sch-III-2"]), { ...profile, business_type: "company" }).tier).toBe("lga");
    expect(collectorFor({ ...claim("x", ["TLA-1998-sch-III-2"]), tier: "state" }, profile).tier).toBe("lga");
  });

  it("puts a Part III line in the map's LGA column, headed '<LGA> LGA · <LGA> Local Government'", () => {
    const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf-8");
    const tierOf = new Function(`${/const tierOf = .*;/.exec(js)?.[0] ?? ""}; return tierOf;`)() as (c: unknown) => string;
    const c = claim("The Ikeja Local Government may collect tenement rates.", ["TLA-1998-sch-III-2"]);
    expect(tierOf({ claim: c, collector: collectorFor(c, profile) })).toBe("lga");
    expect(js).toContain("{ tier: \"lga\", place: `${lga} LGA`, agency: AGENCY.lga(lga) }");
    expect(js).toContain('el("span", { className: "taxmap-place", text: col.place }), " · ", el("span", { className: "taxmap-agency", text: col.agency })');
    // "Being added" only where a tier has no line
    expect(js).toMatch(/const body = mine\.length\s+\? el\(\s+"ul"[\s\S]*?: el\("p", \{ className: "taxmap-empty", text: "Being added" \}\);/);
  });
});

describe("Critic: amounts from the levies Act", () => {
  const read = (id: string): SectionRead => {
    const i = levies().get(id) as LevyItem;
    return { heading: itemHeading(i), text: i.text, act_id: i.act_id, section_no: i.item_no };
  };
  const reply = (body: unknown) => textTurn(body);

  it("knows what an amount is", () => {
    for (const s of ["N10,000", "₦5,000 per annum", "not more than N100", "NGN 2000", "1,000 per annum", "100 naira", "one hundred naira"]) expect(statesAmount(s), s).toBe(true);
    for (const s of ["Schedule, Part III, item 20", "s. 1(1)", "the 1998 Act", "Part II", "NTA-2025-s9", "TIN 12"]) expect(statesAmount(s), s).toBe(false);
  });

  it("strikes a claim citing the Act that states an amount, without a model call, with the fixed reason", async () => {
    const c = claim("The Lagos State Internal Revenue Service may collect a business premises registration fee of up to N10,000.", ["TLA-1998-sch-II-7"], "Lagos State can charge you up to ₦10,000 to register your premises.");
    expect(statesLevyAmount(c)).toBe(true);
    const r = await critique({ claims: [c], notes: [], unanswered: [] }, { "TLA-1998-sch-II-7": read("TLA-1998-sch-II-7") }, profile, new InMemoryWorldModel());
    expect(chatMock).not.toHaveBeenCalled();
    expect(r.checked[0]).toMatchObject({ verdict: "struck", reason: AMOUNT_REASON, quote: null, plain_checked: false, collector: { tier: "state" } });
    expect(r.checked[0]?.claim.plain).toBe(""); // no plain line carries the figure
    expect(AMOUNT_REASON).toBe("amounts in this Act are 1998 maxima and may be superseded by State law; Tax Map does not assert them");
  });

  it("strikes a claim whose plain line alone states the amount", () => {
    expect(statesLevyAmount(claim("The Lagos State Internal Revenue Service may collect a development levy.", ["TLA-1998-sch-II-8"], "Lagos State can collect up to N100 a year from you."))).toBe(true);
  });

  it("leaves amounts in claims that do not cite the Act to the model", () => {
    expect(statesLevyAmount(claim("A small company has turnover of N50,000,000 or less.", ["NTA-2025-s201"]))).toBe(false);
  });

  it("drops a plain-words fix that brings an amount back", async () => {
    chatMock
      .mockResolvedValueOnce(reply({ verdict: "supported", reason: "Part II lists the fee.", quote: "Business premises registration fee in respect of—", qualifier: null, struck_because: null }))
      .mockResolvedValueOnce(reply({ ok: false, fix: "Lagos State may charge you up to N10,000 to register your premises." }));
    const c = claim("The Lagos State Internal Revenue Service may collect a business premises registration fee.", ["TLA-1998-sch-II-7"], "Lagos State may charge a premises fee.");
    const r = await critique({ claims: [c], notes: [], unanswered: [] }, { "TLA-1998-sch-II-7": read("TLA-1998-sch-II-7") }, profile, new InMemoryWorldModel());
    expect(r.checked[0]).toMatchObject({ verdict: "supported", plain_checked: false });
    expect(r.checked[0]?.claim.plain).toBe("");
  });
});

describe("Critic: 'may collect' claims on a Schedule item", () => {
  it("shows the item with its Part heading and the Collector, and supports a quote of the item's words", async () => {
    chatMock
      .mockResolvedValueOnce(textTurn({ verdict: "supported", reason: "Part III lists signboard and advertisement permit fees for the local government.", quote: "Signboard and advertisement permit fees.", qualifier: null, struck_because: null }))
      .mockResolvedValueOnce(textTurn({ ok: true, fix: null }));
    const i = levies().get("TLA-1998-sch-III-20") as LevyItem;
    const world = new InMemoryWorldModel();
    const r = await critique(
      { claims: [claim("The Ikeja Local Government may collect signboard and advertisement permit fees.", [i.item_id], "Your local government may collect fees for signboards and adverts.")], notes: [], unanswered: [] },
      { [i.item_id]: { heading: itemHeading(i), text: i.text, act_id: i.act_id, section_no: i.item_no } },
      profile,
      world,
    );
    const msg = String((chatMock.mock.calls[0]?.[0] as ChatOptions).messages[1]?.content);
    expect(msg).toContain("Collector: Ikeja Local Government (tier: lga)");
    expect(msg).toContain(`--- TLA-1998-sch-III-20: Schedule, Part III, item 20 (${LGA_TITLE})\nSignboard and advertisement permit fees.`);
    expect(r.checked[0]).toMatchObject({ verdict: "supported", quote_verified: true, plain_checked: true, collector: { tier: "lga", authority: "Ikeja Local Government" } });
  });

  it("has prompt rules for Schedule items: quote the item, supported when the levy and tier match", () => {
    const p = criticSystemPrompt();
    expect(p).toContain("## Schedule items (Taxes and Levies (Approved List for Collection) Act 1998)");
    expect(p).toContain("The quoted text is the Schedule item: quote the item's own words.");
    expect(p).toContain('A claim that an authority "may collect" a levy is "supported" when the item names that levy and the tier in the Part heading matches the Collector');
  });

  it("gives levies-Act definitions only to claims citing it", () => {
    const tla = glossary().filter((e) => e.act_id === "TLA-1998").map((e) => e.term);
    expect(tla).toEqual(["government", "joint tax board", "levy", "tax authority"]);
    const item = { section_id: "TLA-1998-sch-III-13", act_id: "TLA-1998", section_no: "13", heading: "", text: "Merriment and road closure levy.", chapter: null, part: null };
    expect(matchDefinitions("The Ikeja Local Government may collect the merriment and road closure levy.", [item]).map((d) => `${d.section_id}:${d.term}`)).toContain("TLA-1998-s4:levy");
    const nta = { section_id: "NTA-2025-s59", act_id: "NTA-2025", section_no: "59", heading: "", text: "There shall be charged a development levy.", chapter: null, part: null };
    expect(matchDefinitions("A company must pay the development levy.", [nta]).some((d) => d.act_id === "TLA-1998")).toBe(false);
  });
});

describe("drawer: a Schedule item opens with the Act title, its place in the Schedule and the Part heading", () => {
  it("labels item ids as 'Schedule, Part III, item 20' and sections as 's. 3'", () => {
    expect(splitLawId("TLA-1998-sch-III-20")).toEqual({ act: "TLA-1998", no: "", part: "III", item: "20" });
    expect(splitLawId("NTAA-2025-s22")).toEqual({ act: "NTAA-2025", no: "22", part: "", item: "" });
    expect(lawRef("TLA-1998-sch-III-20")).toBe("Schedule, Part III, item 20");
    expect(lawRef("TLA-1998-s1")).toBe("s. 1");
    expect(itemLabel("TLA-1998-sch-III-20")).toBe(lawRef("TLA-1998-sch-III-20")); // server and page agree
  });

  it("titles the drawer with the label and puts the Part heading in its meta line", () => {
    const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf-8");
    expect(js).toContain('$("drawer-title").textContent = item ? lawRef(id) : no ? `Section ${no}` : id;');
    expect(js).toMatch(/if \(s\.kind === "schedule_item"\) \{\s+\$\("drawer-title"\)\.textContent = s\.label \?\? lawRef\(id\);\s+\$\("drawer-meta"\)\.textContent = s\.part_title \?\? "";/);
    expect(js).toContain('$("drawer-act").textContent = actName(act);');
    expect(js).toContain("byAct.set(act, [...(byAct.get(act) ?? []), lawRef(id)]);"); // citations use the same label
  });
});
