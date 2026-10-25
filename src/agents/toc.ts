// The Map of the Acts: sections grouped by Act, chapter and Part, for the Researcher's prompt and for
// resolving the Part a browse_part call names.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One (act_id, chapter, part) group of consecutive sections, as parsed into sections.json. */
export interface TocEntry {
  act_id: string;
  act_title: string;
  chapter: string | null;
  part: string | null;
  first: number;
  last: number;
}

interface SectionRow {
  act_id: string;
  act_title: string;
  section_no: string;
  chapter: string | null;
  part: string | null;
}

/** Groups sections into (act, chapter, part) runs, in document order. */
export function buildTocEntries(sections: SectionRow[]): TocEntry[] {
  const out: TocEntry[] = [];
  for (const s of sections) {
    const no = Number.parseInt(s.section_no, 10);
    const last = out.at(-1);
    if (last && last.act_id === s.act_id && last.chapter === s.chapter && last.part === s.part) {
      last.last = no;
    } else {
      out.push({ act_id: s.act_id, act_title: s.act_title, chapter: s.chapter, part: s.part, first: no, last: no });
    }
  }
  return out;
}

/** The compact "Map of the Acts": one line per (chapter, part) with its section range. */
export function formatToc(entries: TocEntry[]): string {
  const lines: string[] = [];
  let act = "";
  for (const e of entries) {
    if (e.act_id !== act) {
      act = e.act_id;
      lines.push(`${e.act_id}: ${e.act_title}`);
    }
    const range = e.first === e.last ? `s${e.first}` : `s${e.first}-s${e.last}`;
    lines.push(`  ${range} | chapter: ${e.chapter ?? "(none)"} | part: ${e.part ?? "(none)"}`);
  }
  return lines.join("\n");
}

let cache: TocEntry[] | undefined;

/** Reads data/statutes/sections.json once (from the repo root, whether run from src/ or dist/). */
export function tocEntries(): TocEntry[] {
  if (cache) return cache;
  const candidates = [
    fileURLToPath(new URL("../../data/statutes/sections.json", import.meta.url)),
    resolve(process.cwd(), "data/statutes/sections.json"),
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) throw new Error("data/statutes/sections.json not found; run scripts/parse_acts.py");
  cache = buildTocEntries(JSON.parse(readFileSync(file, "utf-8")) as SectionRow[]);
  return cache;
}

const norm = (s: string) => s.toUpperCase().replace(/[‐-―−-]/g, "-").replace(/\s+/g, " ").trim();
/** "PART II – TAXATION OF ..." -> "PART II"; "CHAPTER SIX VALUE ADDED TAX" -> "CHAPTER SIX". */
const label = (s: string) => norm(s).split(/\s*-\s*|\s+/).slice(0, 2).join(" ");
const isNone = (s: string | null | undefined) => !s || /^\(?none\)?$/i.test(s.trim());

function matches(actual: string | null, given: string | null | undefined): boolean {
  if (actual === null) return isNone(given);
  if (isNone(given)) return false;
  const g = norm(given as string);
  return g === norm(actual) || g === label(actual);
}

export type PartLookup = { ok: true; entry: TocEntry } | { ok: false; error: string };

/**
 * Resolves the model's (act_id, chapter, part) to one map entry. Full headings or their labels
 * ("CHAPTER SIX", "PART II") both work; the chapter may be left out when the part is unique.
 */
export function findPart(
  entries: TocEntry[],
  actId: string,
  chapter: string | null | undefined,
  part: string | null | undefined,
): PartLookup {
  const inAct = entries.filter((e) => e.act_id === actId);
  if (inAct.length === 0) return { ok: false, error: `Unknown act_id '${actId}'.` };
  let hits = inAct.filter((e) => matches(e.part, part) && matches(e.chapter, chapter));
  if (hits.length === 0 && isNone(chapter)) hits = inAct.filter((e) => matches(e.part, part));
  if (hits.length === 1 && hits[0]) return { ok: true, entry: hits[0] };
  if (hits.length > 1) {
    return { ok: false, error: `Several parts match in ${actId}; also give the chapter exactly as in the Map of the Acts.` };
  }
  return { ok: false, error: `No such part in ${actId}. Copy chapter and part from the Map of the Acts.` };
}
