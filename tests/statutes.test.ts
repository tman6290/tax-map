import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Section {
  section_id: string;
  act_id: string;
  section_no: string;
  text: string;
}

const sections: Section[] = JSON.parse(
  readFileSync(new URL("../data/statutes/sections.json", import.meta.url), "utf-8"),
);

describe("data/statutes/sections.json", () => {
  it("contains the four 2025 Acts and the 1998 levies Act", () => {
    expect([...new Set(sections.map((s) => s.act_id))]).toEqual(["NTA-2025", "NTAA-2025", "NRSEA-2025", "JRBEA-2025", "TLA-1998"]);
  });

  it("has 202 sections in the Nigeria Tax Act (FGP copy)", () => {
    expect(sections.filter((s) => s.act_id === "NTA-2025")).toHaveLength(202);
  });

  it("has non-empty text in every section", () => {
    const empty = sections.filter((s) => s.text.trim() === "").map((s) => s.section_id);
    expect(empty).toEqual([]);
  });

  it("has no duplicate section_id", () => {
    const ids = sections.map((s) => s.section_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists section_no in document order within each Act", () => {
    const byAct = new Map<string, number[]>();
    for (const s of sections) {
      const nums = byAct.get(s.act_id) ?? [];
      nums.push(Number.parseInt(s.section_no, 10));
      byAct.set(s.act_id, nums);
    }
    for (const [actId, nums] of byAct) {
      expect(nums, actId).toEqual([...nums].sort((a, b) => a - b));
    }
  });

  it("has no line-break hyphen left in text (letter, hyphen, space, lowercase)", () => {
    // suspended hyphens such as "pre- and post-" are legitimate and excluded
    const re = /[A-Za-z]- (?!(?:and|or|to)\b)[a-z]/;
    const bad = sections.filter((s) => re.test(s.text)).map((s) => s.section_id);
    expect(bad).toEqual([]);
  });
});
