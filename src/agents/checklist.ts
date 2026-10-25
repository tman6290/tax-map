import { corpus } from "./glossary.js";
import { levies } from "./levies.js";
import { tocEntries, type TocEntry } from "./toc.js";
import type { Claim, Profile } from "./types.js";

/** One area of the coverage checklist in researcher.md. */
export interface ChecklistArea {
  key: "a" | "b" | "c" | "d" | "e" | "f";
  label: string;
  /** Matched against claim text and cited section headings (see covers). */
  wording: RegExp;
  parts: Array<{ act_id: string; chapter?: RegExp; part?: RegExp }>;
  /** The area's targeted turn also lists the State and LGA items of the levies Schedule (list_levies). */
  levies?: boolean;
}

/** The checklist areas that apply to a profile, with the labels used in targeted turns. */
export function checklistAreas(profile: Profile): ChecklistArea[] {
  const company = profile.business_type === "company";
  const areas: ChecklistArea[] = [
    {
      key: "a",
      label: "Registration and tax identification",
      wording: /regist|tax identification|\btax id\b|\btin\b/i,
      parts: [{ act_id: "NTAA-2025", part: /REGISTRATION/ }],
    },
    {
      key: "b",
      label: company
        ? "Tax on business profits (companies income tax)"
        : `Tax on business profits (personal income tax for a ${profile.business_type === "partnership" ? "partner" : "sole proprietor"})`,
      wording: /income tax|profits? (?:or gains )?(?:are|is) chargeable|chargeable (?:profits|income)|assessable profits|tax on (?:business )?profits/i,
      parts: [
        { act_id: "NTA-2025", chapter: /TAXATION OF INCOME OF PERSONS/, part: /IMPOSITION OF TAX/ },
        { act_id: "NTA-2025", chapter: /TAXATION OF INCOME OF PERSONS/, part: company ? /TOTAL PROFITS OF COMPANIES/ : /TOTAL INCOME OF AN INDIVIDUAL/ },
        { act_id: "NTA-2025", chapter: /TAXATION OF INCOME OF PERSONS/, part: /RATES OF TAX/ },
      ],
    },
    {
      key: "c",
      label: "Employer obligations (PAYE deduction and remittance)",
      wording: /\bpaye\b|pay as you earn|employ(?:er|ee)s?'? (?:income|tax|remunerat)/i,
      parts: [{ act_id: "NTAA-2025", part: /RETURNS/ }],
    },
    {
      key: "d",
      label: "VAT (registration, charging and filing, with the small-business rules applied)",
      wording: /\bvat\b|value added tax/i,
      parts: [
        { act_id: "NTA-2025", chapter: /VALUE ADDED TAX/ },
        { act_id: "NTA-2025", part: /EXEMPTION FROM VALUE ADDED TAX/ },
        { act_id: "NTAA-2025", part: /RETURNS/ },
      ],
    },
    {
      key: "e",
      label: "Record keeping and returns",
      wording: /record|books? of account|bookkeep|accounts? (?:of|for) (?:all|the) (?:business|transactions)|income tax returns?|annual returns?/i,
      parts: [{ act_id: "NTAA-2025", part: /RETURNS/ }],
    },
    {
      key: "f",
      label: "Any levy the Acts impose on businesses of this profile",
      wording: /\blev(?:y|ies)\b|surcharge|\bmay collect\b/i,
      parts: [
        { act_id: "NTA-2025", part: /LEVY/ },
        { act_id: "NTA-2025", chapter: /SURCHARGE/ },
      ],
      levies: true,
    },
  ];
  return areas.filter((a) => a.key !== "c" || profile.employees > 0);
}

/** The map entries (Parts, or chapters without Parts) an area points to. */
export function areaParts(area: ChecklistArea, entries: TocEntry[] = tocEntries()): TocEntry[] {
  return entries.filter((e) =>
    area.parts.some(
      (p) =>
        e.act_id === p.act_id &&
        (!p.chapter || p.chapter.test(e.chapter ?? "")) &&
        (!p.part || p.part.test(e.part ?? "")),
    ),
  );
}

/**
 * True when a claim (obligation or exemption) addresses the area: its text, or the heading of a section
 * it cites, matches the area's wording. Part membership alone is not enough, because one Part (NTAA
 * "RETURNS") holds PAYE, VAT returns and books of account alike.
 */
export function covers(claim: Claim, area: ChecklistArea, heading: (id: string) => string = corpusHeading): boolean {
  return area.wording.test(claim.text) || claim.section_ids.some((id) => area.wording.test(heading(id)));
}

/** A section's heading, or for a Schedule item the Part's heading ("Taxes and levies to be collected by ..."). */
function corpusHeading(id: string): string {
  return corpus().get(id)?.heading ?? levies().get(id)?.part_title ?? "";
}

/**
 * Areas no claim covers. Only claims count: an unanswered entry never satisfies the checklist, because
 * in a live run the model used them to skip areas the Acts do address.
 */
export function uncoveredAreas(claims: Claim[], profile: Profile, heading: (id: string) => string = corpusHeading): ChecklistArea[] {
  return checklistAreas(profile).filter((a) => !claims.some((c) => covers(c, a, heading)));
}

/** "NTAA-2025 PART I – RETURNS (s10-s33)" style labels for an area's Parts. */
export function describeParts(parts: TocEntry[]): string {
  return parts
    .map((e) => `${e.act_id} ${[e.chapter, e.part].filter(Boolean).join(" / ")} (s${e.first}-s${e.last})`)
    .join("; ");
}
