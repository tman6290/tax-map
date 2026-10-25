import { beforeEach, describe, expect, it, vi } from "vitest";
import { critique, criticSystemPrompt } from "../src/agents/critic.js";
import { itemHeading, levies, limitLevyClaims, MAX_LEVY_CLAIMS, profileFactPattern, type LevyItem } from "../src/agents/levies.js";
import { levySteer, research, researcherSystemPrompt } from "../src/agents/researcher.js";
import type { Claim, Profile } from "../src/agents/types.js";
import { runSql } from "../src/data/zetaris.js";
import { InMemoryRunMemory } from "../src/engines/hmem/index.js";
import { InMemoryWorldModel } from "../src/engines/world_model/index.js";
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

let n = 0;
const receipt = () => ({ receipt_id: `r${++n}`, decision_id: "d", requested_model: "m", routed_model: "nvidia/nemotron", provider: "nvidia", label: "", tier: "A", kind: "cloud", input_tokens: 1, output_tokens: 1, latency_ms: 1, signed: true });
const toolTurn = (name: string, args: unknown) => ({
  message: { role: "assistant" as const, content: null, tool_calls: [{ id: `call_${name}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] },
  receipt: receipt(),
  raw_id: "x",
});
const textTurn = (body: unknown) => ({ message: { role: "assistant" as const, content: typeof body === "string" ? body : JSON.stringify(body) }, receipt: receipt(), raw_id: "x" });

const levyResult = (...ids: string[]) => ({
  columns: ["item_id", "act_id", "part", "part_title", "tier", "item_no", "text"],
  rows: ids.map((id) => {
    const i = levies().get(id) as LevyItem;
    return [i.item_id, i.act_id, i.part, i.part_title, i.tier, i.item_no, i.text];
  }),
});

const levyClaim = (id: string, itemNos: string[], text: string): Claim => ({
  id,
  type: "obligation",
  text,
  plain: "",
  section_ids: itemNos.map((no) => `TLA-1998-sch-III-${no}`),
  tier: "federal",
  agency: null,
});
const SIGN = "Because the shop has a signboard, the Ikeja Local Government may collect signboard and advertisement permit fees.";
const CATTLE = "The Ikeja Local Government may collect cattle tax.";

beforeEach(() => {
  chatMock.mockReset();
  sqlMock.mockReset();
});

describe("levy claims after the draft", () => {
  it("keeps the first of claims that cite the same items, in any order, and notes the drop", () => {
    const r = limitLevyClaims(
      [
        levyClaim("c1", ["20"], SIGN),
        levyClaim("c2", ["20"], "Because the shop has a signboard, the Ikeja Local Government may collect advertisement permit fees."),
        levyClaim("c3", ["1", "2"], "Because the shop has premises, the Ikeja Local Government may collect shop and tenement rates."),
        levyClaim("c4", ["2", "1"], "Because the shop is in retail, the Ikeja Local Government may collect shop and tenement rates."),
      ],
      profile,
    );
    expect(r.claims.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(r.notes).toEqual(["Dropped claims c2, c4: they repeat an earlier levy claim on the same Schedule item."]);
  });

  it("drops a claim whose items are all claimed already, but keeps one that adds an item", () => {
    const r = limitLevyClaims(
      [
        levyClaim("c1", ["1", "2"], "Because the shop has premises, the Ikeja Local Government may collect shop and tenement rates."),
        levyClaim("c2", ["2"], "Because the shop has premises, the Ikeja Local Government may collect tenement rates."),
        levyClaim("c3", ["2", "3"], "Because the shop sells goods, the Ikeja Local Government may collect tenement rates and liquor licence fees."),
      ],
      profile,
    );
    expect(r.claims.map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("caps levy claims at 6, keeping the first six, and leaves claims that cite no item alone", () => {
    const many = Array.from({ length: 9 }, (_, i) => levyClaim(`c${i + 1}`, [String(i + 1)], `Because the shop has premises, the Ikeja Local Government may collect levy number ${i + 1}.`));
    const vat: Claim = { id: "v1", type: "obligation", text: "The business must register for VAT.", plain: "", section_ids: ["NTAA-2025-s22"], tier: "federal", agency: null };
    const r = limitLevyClaims([vat, ...many], profile);
    expect(MAX_LEVY_CLAIMS).toBe(6);
    expect(r.claims.map((c) => c.id)).toEqual(["v1", "c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(r.notes).toEqual(["Dropped claims c7, c8, c9: an answer holds at most 6 levy claims."]);
  });

  it("drops a levy claim that names no profile fact and says so in the notes; a dropped claim takes no slot in the cap", () => {
    const r = limitLevyClaims(
      [
        levyClaim("c1", ["12"], CATTLE),
        levyClaim("c2", ["9"], "The Ikeja Local Government may collect motor park levies."),
        levyClaim("c3", ["20"], SIGN),
        levyClaim("c4", ["2"], "Because the business has premises, the Ikeja Local Government may collect tenement rates."),
        levyClaim("c5", ["1"], "As a retail business, the Ikeja Local Government may collect shop and kiosk rates."),
        levyClaim("c6", ["17"], "Because it has 3 employees, the Ikeja Local Government may collect refuse disposal fees."),
        levyClaim("c7", ["3"], "Given its turnover under the limit, the Ikeja Local Government may collect liquor licence fees."),
      ],
      profile,
    );
    expect(r.claims.map((c) => c.id)).toEqual(["c3", "c4", "c5", "c6", "c7"]);
    expect(r.notes).toEqual([expect.stringMatching(/^Dropped claims c1, c2: a levy claim must name a fact about the business \(premises, signage, sector, employees or turnover\)/)]);
  });

  it("counts premises and signage as facts only when the profile has them", () => {
    const none = { ...profile, has_premises: false, has_signage: false, employees: 0 };
    const signboard = "Because it has a signboard, the Ikeja Local Government may collect permit fees.";
    expect(profileFactPattern(profile).test(signboard)).toBe(true);
    expect(profileFactPattern(none).test(signboard)).toBe(false);
    expect(profileFactPattern(none).test("The Ikeja Local Government may collect tenement rates on its premises.")).toBe(false);
    expect(profileFactPattern(none).test("Because the shop trades in goods, the Ikeja Local Government may collect shop rates.")).toBe(true); // the retail sector
    expect(profileFactPattern({ ...none, sector: "hospitality" }).test("Because it is a hotel, the Ikeja Local Government may collect liquor licence fees.")).toBe(true);
  });

  it("applies all three to the Researcher's answer and records the drops in its notes", async () => {
    sqlMock.mockResolvedValue(levyResult("TLA-1998-sch-III-20", "TLA-1998-sch-III-12"));
    chatMock
      .mockResolvedValueOnce(toolTurn("list_levies", { tier: "lga" }))
      .mockResolvedValueOnce(textTurn({ claims: [levyClaim("c1", ["20"], SIGN), levyClaim("c2", ["12"], CATTLE), levyClaim("c3", ["20"], SIGN)], notes: [], unanswered: [] }));
    const r = await research(profile, "What levies apply?", new InMemoryRunMemory(), { coverage: false });
    expect(r.draft.claims.map((c) => c.id)).toEqual(["c1"]);
    expect(r.draft.notes).toEqual(
      expect.arrayContaining(["Dropped claims c3: they repeat an earlier levy claim on the same Schedule item.", expect.stringMatching(/^Dropped claims c2: a levy claim must name a fact/)]),
    );
  });
});

describe("Researcher prompt: which levies to draft", () => {
  it("says which levy matches which fact, which never apply to a shop, and the one-per-item and six-claim limits", () => {
    const p = researcherSystemPrompt();
    expect(p).toContain("Draft a levy claim only when the levy's subject matches a fact in the profile or the question");
    for (const rule of [
      "shop or kiosk rates, for a trading business",
      "tenement rate, for a business with premises",
      "signboard and advertisement permit fees, for a business with signage",
      "business premises registration, for a business with premises",
      "liquor licence fees, only if the sector is drinks or hospitality",
      "market taxes and levies, only for a market trader",
    ]) {
      expect(p).toContain(rule);
    }
    expect(p).toContain("Levies about cattle, canoes, bicycles, slaughter, burials, marriages, religious places, radio licences, motor parks or wrong parking are not relevant to a shop and must not be drafted.");
    expect(p).toContain("at most one claim per `item_id`, and at most 6 levy claims in the answer");
    expect(p).toContain('must name the profile fact it rests on, for example "Because the shop has a signboard, the Ikeja Local Government may collect signboard and advertisement permit fees."');
    // the pointer for signage and premises names the rule, not an item number
    const steer = levySteer(profile).join(" ");
    expect(steer).toContain("Draft a claim only for an item whose subject matches a fact about this business, name that fact in the claim");
    expect(steer).not.toMatch(/item\s+\d|sch-/i);
  });
});

describe("Critic: a levy that does not fit the business", () => {
  it("strikes a cattle-tax claim for a retail shop, with the reason naming the mismatch, and shows the Critic the question", async () => {
    const reason = "the item is a cattle tax payable by cattle farmers only, which does not apply to a retail shop";
    chatMock.mockResolvedValueOnce(textTurn({ verdict: "struck", reason, quote: "Cattle tax payable by cattle farmers only.", qualifier: null, struck_because: "not_established" }));
    const i = levies().get("TLA-1998-sch-III-12") as LevyItem;
    const r = await critique(
      { claims: [levyClaim("c1", ["12"], CATTLE)], notes: [], unanswered: [] },
      { [i.item_id]: { heading: itemHeading(i), text: i.text, act_id: i.act_id, section_no: i.item_no } },
      profile,
      new InMemoryWorldModel(),
    );
    const msg = String((chatMock.mock.calls[0]?.[0] as ChatOptions).messages[1]?.content);
    expect(msg).toContain('"sector": "retail"');
    expect(msg).toContain("Cattle tax payable by cattle farmers only.");
    expect(msg).toContain("does the quoted item describe a levy that applies to this business given the profile, and does the claim say only that the authority may collect it?");
    expect(r.checked[0]).toMatchObject({ verdict: "struck", quote_verified: true });
    expect(r.checked[0]?.reason).toContain("does not apply to a retail shop");
    expect(r.checked[0]?.collector.tier).toBe("lga"); // placement is unchanged
  });

  it("has prompt rules: supported only when the item names the levy, the tier matches and its subject fits the profile", () => {
    const p = criticSystemPrompt();
    expect(p).toContain("does the quoted item describe a levy that applies to this business, given the profile");
    expect(p).toContain("does the claim say only that the authority may collect it?");
    expect(p).toContain('"supported" only when both hold');
    expect(p).toContain("It does not match levies about cattle, canoes, bicycles, slaughter, burials, marriages, religious places, radio licences, motor parks or wrong parking.");
    expect(p).toContain('If the item\'s subject does not match the profile, the verdict is "struck"');
    expect(p).toContain("`reason` names the mismatch");
  });
});
