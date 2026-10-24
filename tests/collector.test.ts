import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLLECTOR_SECTION, collectorFor, NRS } from "../src/agents/collector.js";
import { corpus } from "../src/agents/glossary.js";
import type { Profile } from "../src/agents/types.js";

const sole: Profile = { business_type: "sole_proprietor", sector: "retail", state: "Lagos", lga: "Ikeja", turnover_band: "under_25m", fixed_assets_band: "under_250m", employees: 3, has_premises: true, has_signage: true };
const company: Profile = { ...sole, business_type: "company" };
const partner: Profile = { ...sole, business_type: "partnership" };
const claim = (text: string, tier: "federal" | "state" | "lga" = "federal") => ({ text, tier });

const LIRS = "Lagos State Internal Revenue Service";

describe("collector: who collects the tax a claim is about", () => {
  it("sends income tax, PAYE, returns and registration for a sole proprietor to the State", () => {
    for (const text of [
      "The business must register with the relevant tax authority and obtain a Taxpayer Identification Number (Tax ID).",
      "The Tax ID must be stated on all returns, notices and correspondence.",
      "The business must notify the tax authority within 30 days of any change in its particulars.",
      "As an employer, the business must file a PAYE return for all emoluments paid to its employees.",
      "The business must deduct PAYE from its employees' pay and remit it.",
      "The business must file an annual income tax return.",
      "Personal income tax is charged on the profits of the business.",
      "The business must keep books or records of accounts for its business.", // record-keeping, same basis (s. 3(2))
      "You must keep proper books of account and records of all transactions.",
    ]) {
      expect(collectorFor(claim(text), sole), text).toMatchObject({ tier: "state", authority: LIRS });
    }
  });

  it("treats a partner as an individual too", () => {
    expect(collectorFor(claim("The business must file an annual income tax return."), partner)).toMatchObject({ tier: "state", authority: LIRS });
  });

  it("gives record-keeping the same State basis, and keeps it federal for a company or when it is about VAT", () => {
    const books = "The business must keep books or records of accounts for its business.";
    expect(collectorFor(claim(books), sole)).toMatchObject({ tier: "state", section_id: COLLECTOR_SECTION, basis: collectorFor(claim("The business must file an annual income tax return."), sole).basis });
    expect(collectorFor(claim(books), partner).tier).toBe("state");
    expect(collectorFor(claim(books), company)).toMatchObject({ tier: "federal", authority: NRS });
    expect(collectorFor(claim("The business must keep records of VAT invoices."), sole).tier).toBe("federal");
  });

  it("sends VAT, the development levy and companies income tax to the Nigeria Revenue Service", () => {
    for (const text of [
      "The business must register for Value Added Tax and charge VAT on taxable supplies.",
      "The business must submit a VAT return by the 21st day of the following month.", // a return, but VAT: federal
      "You do not have to pay the development levy because you are not a company.",
      "A company must pay companies income tax on its profits.",
      "A non-resident person is taxed on profit derived from Nigeria.",
    ]) {
      expect(collectorFor(claim(text), sole), text).toMatchObject({ tier: "federal", authority: NRS });
    }
  });

  it("sends every obligation of a company to the Nigeria Revenue Service, even registration and returns", () => {
    for (const text of ["The company must register and obtain a Tax ID.", "The company must file an annual income tax return.", "The company must deduct PAYE."]) {
      expect(collectorFor(claim(text), company), text).toMatchObject({ tier: "federal", authority: NRS });
    }
  });

  it("defaults to federal when nothing places a claim with a State", () => {
    const c = collectorFor(claim("The business must display its business name at its premises."), sole);
    expect(c).toMatchObject({ tier: "federal", authority: NRS, section_id: null });
    expect(c.basis).toMatch(/No State or local rule applies/);
  });

  it("puts a claim that cites a State or LGA instrument under that tier (none is loaded yet)", () => {
    expect(collectorFor(claim("A signage fee is payable.", "state"), sole)).toMatchObject({ tier: "state", authority: LIRS });
    expect(collectorFor(claim("A signage fee is payable.", "lga"), sole)).toMatchObject({ tier: "lga", authority: "Ikeja Local Government" });
    // an instrument-tier claim is placed there even when its wording looks federal
    expect(collectorFor(claim("VAT applies.", "state"), sole).tier).toBe("state");
  });

  it("names the State from the profile", () => {
    expect(collectorFor(claim("The business must file an annual income tax return."), { ...sole, state: "Ogun" }).authority).toBe("Ogun State Internal Revenue Service");
  });

  it("gives a basis that cites the Act and section it rests on", () => {
    const state = collectorFor(claim("The business must file an annual income tax return."), sole);
    expect(state.section_id).toBe(COLLECTOR_SECTION);
    expect(state.basis).toContain("Nigeria Tax Administration Act 2025, s. 3(2)");
    expect(state.basis).toContain("resident individuals");
    expect(state.basis).toContain("Lagos State");
    const federal = collectorFor(claim("The business must charge VAT."), sole);
    expect(federal.basis).toContain("Nigeria Tax Administration Act 2025, s. 3(1)(a)");
    expect(collectorFor(claim("The company must register."), company).basis).toContain("taxes on companies");
  });

  it("rests on what NTAA s. 3 says in the loaded Acts", () => {
    const s3 = corpus().get(COLLECTOR_SECTION);
    expect(s3?.heading).toMatch(/Jurisdiction of tax authorities/i);
    const text = (s3?.text ?? "").replace(/\s+/g, " ");
    // (1)(a): the Service has exclusive responsibility for companies, VAT and the development levy
    expect(text).toMatch(/\(1\) The Nigeria Revenue Service .*exclusive responsibility to administer taxes : \(i\) on companies/);
    expect(text).toMatch(/development levy.*value added tax/);
    // (2): the relevant tax authority in a State administers taxes for resident individuals, on income
    expect(text).toMatch(/\(2\) The relevant tax authority in a State .*the administration of taxes for resident individuals in respect of .{0,3}\(i\) imposition of tax on income, profits or gains/);
  });
});

describe("collector in the page", () => {
  const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf-8");
  const js = read("app.js");

  it("keeps the page's column authorities in step with the collector's", () => {
    const src = /const AGENCY = \{[\s\S]*?\n\};/.exec(js)?.[0] ?? "";
    const AGENCY = new Function(`${src}; return AGENCY;`)() as Record<string, (x?: string) => string>;
    expect(AGENCY.federal!()).toBe(NRS);
    expect(AGENCY.state!("Lagos")).toBe(collectorFor(claim("income tax"), sole).authority);
    expect(AGENCY.lga!("Ikeja")).toBe(collectorFor(claim("x", "lga"), sole).authority);
  });

  it("places chips by collector.tier, with the basis as the chip's title", () => {
    expect(js).toContain("const tierOf = (c) => c.collector?.tier ?? c.claim.tier ?? \"federal\";");
    expect(js).toContain("mainClaims.filter((c) => tierOf(c) === col.tier)");
    expect(js).toContain("...(c.collector?.basis ? { title: c.collector.basis } : {})");
  });

  it("adds 'Collected by: <authority>' with a help marker to cards in the answer, not to set-aside cards", () => {
    expect(js).toContain("`Collected by: ${col.authority}`");
    expect(js).toContain("text: col.basis, law: col.section_id ? [col.section_id] : []");
    expect(js).toContain("card.append(...claimHead(c), claimMeta(c, true));"); // the answer's cards
    expect(/function setAsideCard\(c\) \{[\s\S]*?\n\}/.exec(js)?.[0]).not.toContain("claimMeta(c, true)");
  });
});
