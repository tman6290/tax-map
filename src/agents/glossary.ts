import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One defined term from an interpretation section. */
export interface GlossaryEntry {
  term: string; // lowercased
  act_id: string;
  section_id: string;
  definition: string; // the paragraph for this term only, at most DEFINITION_CHARS
  /** "act" for an "In this Act" section; "part" for one scoped to its own Part ("In this Part"). */
  scope: "act" | "part";
  chapter: string | null;
  part: string | null;
}

export interface CorpusSection {
  section_id: string;
  act_id: string;
  section_no: string;
  heading: string | null;
  text: string;
  chapter: string | null;
  part: string | null;
}

const DEFINITION_CHARS = 1_200;

/**
 * Defined terms too generic to help the Critic ("tax", "Nigeria", "president" ...): they matched almost
 * every section and crowded out the definitions that decide a claim. They are never attached.
 */
export const GENERIC_TERMS = new Set([
  "tax",
  "nigeria",
  "person",
  "president",
  "minister",
  "service",
  "board",
  "act",
  "year",
  "month",
  "day",
  "business",
]);
/** Generic unless the claim itself uses the term, in which case it is the operative term. */
export const CLAIM_ONLY_TERMS = new Set(["company"]);

/** True when `text` uses `term` or its plural ("company" / "companies"). */
function usesTerm(text: string, term: string): boolean {
  const stem = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/y$/, "(?:y|ie)");
  return new RegExp(`(?<![a-z0-9])${stem}s?(?![a-z0-9])`, "i").test(text);
}
const MIN_ENTRIES = 3; // fewer quoted-term entries than this and a section is not treated as a glossary
export const MAX_DEFINITIONS = 8;

/**
 * An entry starts with a quoted term at the start of the text or after ; . : or a dash, followed by
 * lowercase text: `"small business" means ...` or, as in NTA s201, `"small company" a business ...`.
 * A quoted word inside a definition (`includes "x"`) follows a word, so it does not start an entry.
 */
const ENTRY_RE = /(?:^|[;.:—–-]\s*|\bAct\s*)["“]([^"”]{2,80})["”]\s*,?\s+(?=[a-z(])/g;

function interpretationCandidate(s: CorpusSection): boolean {
  return /interpretation/i.test(s.heading ?? "") || /interpretation/i.test(s.part ?? "");
}

/** The quoted-term entries of one interpretation section, verified by there being at least MIN_ENTRIES. */
export function parseEntries(s: CorpusSection): GlossaryEntry[] {
  const starts = [...s.text.matchAll(ENTRY_RE)].map((m) => ({
    term: (m[1] ?? "").trim().toLowerCase().replace(/\s+/g, " "),
    at: (m.index ?? 0) + m[0].search(/["“]/),
  }));
  if (starts.length < MIN_ENTRIES) return [];
  const scope = /^\s*In this (?:Act|Law)\b/i.test(s.text) ? "act" : "part";
  return starts.map((st, i) => {
    const end = starts[i + 1]?.at ?? s.text.length;
    let definition = s.text.slice(st.at, end).trim().replace(/[;\s]+$/, "");
    if (definition.length > DEFINITION_CHARS) definition = `${definition.slice(0, DEFINITION_CHARS)} [truncated]`;
    return { term: st.term, act_id: s.act_id, section_id: s.section_id, definition, scope, chapter: s.chapter, part: s.part };
  });
}

export function buildGlossary(sections: CorpusSection[]): GlossaryEntry[] {
  return sections.filter(interpretationCandidate).flatMap(parseEntries);
}

let corpusCache: Map<string, CorpusSection> | undefined;
let glossaryCache: GlossaryEntry[] | undefined;

/** data/statutes/sections.json, read once, keyed by section_id. */
export function corpus(): Map<string, CorpusSection> {
  if (corpusCache) return corpusCache;
  const candidates = [
    fileURLToPath(new URL("../../data/statutes/sections.json", import.meta.url)),
    resolve(process.cwd(), "data/statutes/sections.json"),
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) throw new Error("data/statutes/sections.json not found; run scripts/parse_acts.py");
  const rows = JSON.parse(readFileSync(file, "utf-8")) as CorpusSection[];
  corpusCache = new Map(rows.map((r) => [r.section_id, r]));
  return corpusCache;
}

/** The glossary of every Act, parsed once at first use. */
export function glossary(): GlossaryEntry[] {
  glossaryCache ??= buildGlossary([...corpus().values()]);
  return glossaryCache;
}

export function isGlossarySection(sectionId: string, entries: GlossaryEntry[] = glossary()): boolean {
  return entries.some((e) => e.section_id === sectionId);
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The definition that applies to a term used in a cited section: a Part-scoped definition when the
 * section is in that Part, else the Act-wide one, else (laws cross-refer) another Act's Act-wide one.
 */
function resolveTerm(entries: GlossaryEntry[], cited: CorpusSection[]): GlossaryEntry | undefined {
  for (const s of cited) {
    const local = entries.find((e) => e.act_id === s.act_id && e.scope === "part" && e.chapter === s.chapter && e.part === s.part);
    if (local) return local;
  }
  const acts = new Set(cited.map((s) => s.act_id));
  return (
    entries.find((e) => acts.has(e.act_id) && e.scope === "act") ??
    entries.find((e) => e.scope === "act")
  );
}

/**
 * Glossary definitions for the terms used in a claim and in its cited (non-glossary) sections.
 * Longest terms match first at word boundaries, so "small company" is found before "company".
 * Ordered claim matches first, then multi-word terms, then position; at most `max`.
 */
export function matchDefinitions(
  claimText: string,
  cited: CorpusSection[],
  entries: GlossaryEntry[] = glossary(),
  max = MAX_DEFINITIONS,
): GlossaryEntry[] {
  const byTerm = new Map<string, GlossaryEntry[]>();
  for (const e of entries) byTerm.set(e.term, [...(byTerm.get(e.term) ?? []), e]);
  const terms = [...byTerm.keys()].sort((a, b) => b.length - a.length);
  const operative = cited.filter((s) => !isGlossarySection(s.section_id, entries));
  const haystacks = [claimText, ...operative.map((s) => s.text)];

  const found = new Map<string, { priority: number; pos: number }>();
  haystacks.forEach((h, priority) => {
    let text = fold(h);
    for (const term of terms) {
      const re = new RegExp(`(?<![a-z0-9])${escape(term)}(?![a-z0-9])`, "g");
      let first = -1;
      text = text.replace(re, (m, pos: number) => {
        if (first < 0) first = pos;
        return " ".repeat(m.length); // mask, so shorter terms inside it do not match here
      });
      if (first >= 0 && !found.has(term)) found.set(term, { priority: Math.min(priority, 1), pos: first });
    }
  });

  const ranked = [...found.entries()].sort(
    ([ta, a], [tb, b]) => a.priority - b.priority || tb.split(" ").length - ta.split(" ").length || a.pos - b.pos,
  );
  const out: GlossaryEntry[] = [];
  for (const [term, at] of ranked) {
    if (GENERIC_TERMS.has(term)) continue;
    // e.g. "company": only when the claim itself turns on it (singular or plural)
    if (CLAIM_ONLY_TERMS.has(term) && at.priority !== 0 && !usesTerm(claimText, term)) continue;
    const entry = resolveTerm(byTerm.get(term) ?? [], operative.length ? operative : cited);
    if (entry && !out.includes(entry)) out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}
