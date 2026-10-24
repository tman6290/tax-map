import { describe, expect, it } from "vitest";
import { buildGlossary, glossary, matchDefinitions, parseEntries, type CorpusSection } from "../src/agents/glossary.js";

const sec = (over: Partial<CorpusSection>): CorpusSection => ({
  section_id: "X-2025-s1",
  act_id: "X-2025",
  section_no: "1",
  heading: "Interpretation",
  text: "",
  chapter: null,
  part: null,
  ...over,
});

const ACT_DEFS = sec({
  section_id: "TST-2025-s90",
  act_id: "TST-2025",
  text:
    'In this Act — "company" means any body corporate incorporated under law ; ' +
    '"small company" a business that earns gross turnover of N100,000,000 or less per annum ; ' +
    '"taxable person" includes an individual or body of individuals who carries out an "economic activity" ; ' +
    '"turnover" means gross revenue.',
});
const PART_DEFS = sec({
  section_id: "TST-2025-s50",
  act_id: "TST-2025",
  part: "PART IV – EXEMPTIONS",
  text: 'In this Part — "company" means a company exempt under this Part ; "goods" means movable property ; "supply" means sale.',
});
const OPERATIVE = sec({ section_id: "TST-2025-s10", act_id: "TST-2025", heading: "Returns", text: "A taxable person that is not a small company shall file returns." });

describe("glossary parsing", () => {
  it("splits an interpretation section into one paragraph per quoted term, with or without 'means'", () => {
    const e = parseEntries(ACT_DEFS);
    expect(e.map((x) => x.term)).toEqual(["company", "small company", "taxable person", "turnover"]);
    expect(e[1]?.definition).toBe('"small company" a business that earns gross turnover of N100,000,000 or less per annum');
    // a quoted word inside a definition does not start an entry
    expect(e[2]?.definition).toContain('"economic activity"');
    expect(e.every((x) => x.scope === "act" && x.section_id === "TST-2025-s90")).toBe(true);
  });

  it("verifies by content and scope: too few entries is not a glossary; 'In this Part' is part-scoped", () => {
    expect(parseEntries(sec({ text: 'In this Act — "a" means b.' }))).toEqual([]);
    expect(buildGlossary([PART_DEFS]).every((x) => x.scope === "part")).toBe(true);
    expect(buildGlossary([OPERATIVE])).toEqual([]); // not an interpretation section
  });

  it("parses the real Acts: small business from NTAA, small company from NTA", () => {
    const g = glossary();
    expect(g.find((e) => e.term === "small business")).toMatchObject({ section_id: "NTAA-2025-s147", scope: "act" });
    expect(g.find((e) => e.term === "small company")?.definition).toMatch(/N100,000,000 or less/);
    expect(g.every((e) => e.definition.length <= 1_200 + " [truncated]".length)).toBe(true);
  });
});

describe("term matching", () => {
  const g = buildGlossary([ACT_DEFS, PART_DEFS]);

  it("matches longest terms first at word boundaries, claim terms ahead of section terms", () => {
    const m = matchDefinitions("My company files returns.", [OPERATIVE], g);
    const terms = m.map((e) => e.term);
    expect(terms[0]).toBe("company"); // in the claim
    expect(terms).toContain("small company");
    expect(terms).toContain("taxable person");
    expect(terms).not.toContain("turnover"); // not used
    expect(m.find((e) => e.term === "company")?.section_id).toBe("TST-2025-s90"); // Act-wide, not the Part's
  });

  it("does not match inside other words", () => {
    expect(matchDefinitions("The accompanying goodsheds.", [], g).map((e) => e.term)).toEqual([]);
  });

  it("uses a Part-scoped definition for a section in that Part, and caps the count", () => {
    const inPart = sec({ section_id: "TST-2025-s51", act_id: "TST-2025", heading: "Exempt goods", part: "PART IV – EXEMPTIONS", text: "A company may supply goods." });
    expect(matchDefinitions("x", [inPart], g).find((e) => e.term === "company")?.section_id).toBe("TST-2025-s50");
    expect(matchDefinitions("company goods supply small company taxable person turnover", [OPERATIVE], g, 2)).toHaveLength(2);
  });
});
