import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { criticSystemPrompt } from "../src/agents/critic.js";
import type { Profile } from "../src/agents/types.js";
import { NOT_CONFIRMED, pageLists, pageText } from "../src/api/describe.js";

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

/** Entries as a live run left them (shortened): model entries, coverage lines and housekeeping notes. */
const draft = {
  unanswered: [
    "Personal income tax obligation for sole proprietor's business profits: no section in loaded NTAA-2025 texts imposes PIT on sole proprietor business profits.",
    "Checklist (b) Tax on business profits (personal income tax for a sole proprietor): no claim after a targeted search of NTA-2025 CHAPTER TWO – TAXATION OF INCOME OF PERSONS / PART 1 – IMPOSITION OF TAX ON INCOME, PROFITS OR GAINS (s3-s5).",
    "Employer PAYE deduction and remittance obligations with 3 employees, as NTAA-2025-s14 was not read in full with get_sections in this turn",
    "Checklist (c) Employer obligations (PAYE deduction and remittance): no claim after a targeted search of NTAA-2025 CHAPTER TWO – RETURNS, ASSESSMENT AND PAYMENTS / PART I – RETURNS (s10-s33).",
    "Checklist (e) Record keeping and returns: not searched in a targeted turn (limit of 4 targeted turns reached).",
    "Levies: list_levies was called but the State tier TLA-1998 items, such as TLA-1998-sch-II-7, were not checked",
    "Checklist (f) Any levy the Acts impose on businesses of this profile: no claim after a targeted search of NTA-2025 PART X – DEVELOPMENT LEVY (s59-s59).",
  ],
  notes: [
    "The business has under_25m annual turnover and under_250m fixed assets, qualifying it as a small business under NTAA-2025-s147, which exempts it from VAT return requirements under NTAA-2025-s22(4).",
    "VAT small business exemptions were not found in the loaded sections; the text of NTA-2025 s56 and s147 was read.",
    "Employees are 3, so PAYE obligations apply but NTAA-2025-s14 was not found in full.",
    "note removed: unread section",
    "Coverage revision failed (Meterless request timed out after 150000 ms); kept the draft from before it.",
    "Dropped claims c2: they repeat an earlier levy claim on the same Schedule item.",
  ],
};

describe("Not answered and Notes on the page", () => {
  const page = pageLists(draft, profile);
  const all = [...page.unanswered, ...page.notes].join("\n");

  it("keeps one entry per checklist area, the more specific one", () => {
    expect(page.unanswered).toHaveLength(4); // (b), (c), (e), (f)
    // (b) and (c): the model's own entry says more than the coverage line, so it is kept
    expect(page.unanswered[0]).toMatch(/^Personal income tax obligation for sole proprietor's business profits/);
    expect(page.unanswered[1]).toMatch(/^Employer PAYE deduction and remittance obligations with 3 employees/);
    // (e): only the coverage line, in plain words
    expect(page.unanswered[2]).toBe(`Record keeping and returns: ${NOT_CONFIRMED}.`);
    // (f): the model's levy entry
    expect(page.unanswered[3]).toMatch(/^Levies: the list of levies was read but the State tier/);
  });

  it("says 'the check could not confirm this from the Acts' at most once per area", () => {
    expect(all.split(NOT_CONFIRMED).length - 1).toBe(1);
    const twice = pageLists({ unanswered: [...draft.unanswered, "Checklist (e) Record keeping and returns: no claim after a targeted search of NTAA-2025 PART I – RETURNS (s10-s33)."], notes: [] }, profile);
    expect(twice.unanswered.filter((u) => u.includes(NOT_CONFIRMED))).toHaveLength(1);
  });

  it("never shows tool names, ids, database names or talk of turns", () => {
    expect(all).not.toMatch(/list_levies|get_sections|browse_part|run_sql/);
    expect(all).not.toMatch(/\b(?:NTA|NTAA|NRSEA|JRBEA)-2025|TLA-1998/);
    expect(all).not.toMatch(/\bturns?\b/i);
    expect(all).not.toMatch(/under_25m|under_250m|meterless|taxmap\./i);
    expect(all).toContain("Nigeria Tax Administration Act 2025, s. 14");
    expect(all).toContain("Taxes and Levies (Approved List for Collection) Act 1998, Schedule, Part II, item 7");
    expect(page.notes[0]).toContain("turnover under ₦25 million and fixed assets under ₦250 million");
    expect(page.notes[0]).toContain("Nigeria Tax Administration Act 2025, s. 22(4)");
  });

  it("leaves housekeeping notes and notes that only repeat an absence 'Not answered' covers to the run log", () => {
    // the VAT notes fold into one (the longer); the PAYE absence note goes, since (c) is under Not answered
    expect(page.notes).toHaveLength(1);
    expect(page.notes[0]).toMatch(/^The business has turnover under/);
    expect(all).not.toMatch(/note removed|Coverage revision|Dropped claims|timed out/);
  });

  it("does not change the raw entries, which the run log shows", () => {
    expect(draft.unanswered[5]).toContain("list_levies");
    expect(draft.notes).toHaveLength(6);
    const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf-8");
    expect(js).toContain('fillList("unanswered", "unanswered-block", r.page.unanswered);');
    expect(js).toContain('fillList("notes", "notes-block", r.page.notes);');
    expect(js).toContain("? [...notes, ...unanswered]"); // the run log keeps every entry as written
  });

  it("writes ids and section references as citations", () => {
    expect(pageText("the text of NTA-2025 s56 and s147 was read")).toBe("the text of Nigeria Tax Act 2025, s. 56 and s. 147 was read");
    expect(pageText("see TLA-1998-s1 and JRBEA-2025-s2")).toBe("see Taxes and Levies (Approved List for Collection) Act 1998, s. 1 and Joint Revenue Board of Nigeria (Establishment) Act 2025, s. 2");
  });
});

describe("Critic prompt: substance, not wording", () => {
  const p = criticSystemPrompt();

  it("supports a paraphrase with the same meaning and strikes only a different meaning or a disapplication", () => {
    expect(p).toContain("## Judge substance, not wording");
    expect(p).toContain('A claim that paraphrases the operative text with the same meaning is "supported"');
    expect(p).toContain('"profits" for "profits or gains", "tax office" for "relevant tax authority", or "business" for "trade or business"');
    expect(p).toContain("Strike only when the meaning differs (a different duty, person, deadline, condition or scope) or when the text disapplies the claim for this profile.");
    expect(p).toContain("The quote must still be copied verbatim from the text; only the claim may paraphrase.");
  });

  it("gives two examples, one supported and one struck", () => {
    const examples = p.slice(p.indexOf("Examples (made-up wording"), p.indexOf("## Verdicts"));
    expect(examples.match(/^- Text: /gm)).toHaveLength(2);
    expect(examples).toContain('"supported", quoting that sentence');
    expect(examples).toContain('"struck" with `struck_because` "contradicts"');
  });

  it("keeps the amount rule and the levy relevance rule", () => {
    expect(p).toContain("a levy claim is still struck when it states an amount or when the item's subject does not fit the business");
    expect(p).toContain("If the item's subject does not match the profile, the verdict is \"struck\"");
    expect(p).toContain("A claim that the business must pay the levy, or that states an amount, is not established by the item.");
  });
});
