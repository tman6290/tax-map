import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runSql } from "../data/zetaris.js";
import type { RunMemory, ScoredMemoryEntry } from "../engines/types.js";
import { chat, type ChatMessage, type ChatResult, type Receipt, type ToolCall, type ToolDefinition } from "../providers/meterless.js";
import { areaParts, checklistAreas, describeParts, uncoveredAreas, type ChecklistArea } from "./checklist.js";
import { isItemId, itemHeading, limitLevyClaims, type LevyPart, type LevyTier } from "./levies.js";
import { PROFILE_HEADER } from "./profile.js";
import { findPart, formatToc, tocEntries } from "./toc.js";
import { observedTrace } from "./trace.js";
import type { ClaimType, Draft, Profile, ResearchResult, SectionRead, TraceStep } from "./types.js";

export const MAX_TURNS = 12;
/** Drafting turns on Lightning take 40-60 s; a 60 s limit made the pipeline fail on them. */
const RESEARCHER_TIMEOUT_MS = 150_000;
const DRAFT_MAX_TOKENS = 8_000;
const DRAFT_RETRY_MAX_TOKENS = 16_000; // second try when the 8,000 cap leaves the model no room to answer
/** At most this many targeted turns for uncovered checklist areas, before the revision turn. */
export const MAX_COVERAGE_TURNS = 4;
const SQL_ROW_LIMIT = 40;
const SNIPPET_CHARS = 500;
const MAX_GET_SECTIONS = 10;
const SECTION_ID_RE = /^(?:(?:NTA|NTAA|NRSEA|JRBEA)-2025|TLA-1998)-s\d+$/;
const TABLES = new Set(["taxmap.sections", "taxmap.acts"]);
const LEVY_TIERS: LevyTier[] = ["federal", "state", "lga"];

export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "run_sql",
      description:
        "Run one read-only SELECT against taxmap.sections or taxmap.acts (Spark SQL, no semicolons, max 40 rows). " +
        "Section searches return section_id, act_id, section_no, heading, tier and a 500-character snippet.",
      parameters: {
        type: "object",
        properties: { sql: { type: "string", description: "A single SELECT statement" } },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_part",
      description:
        "List section_id, section_no and heading for every section in one Part of an Act. " +
        "Copy chapter and part from the Map of the Acts; use \"(none)\" where the map shows (none).",
      parameters: {
        type: "object",
        properties: {
          act_id: { type: "string", enum: ["NTA-2025", "NTAA-2025", "NRSEA-2025", "JRBEA-2025", "TLA-1998"] },
          chapter: { type: "string" },
          part: { type: "string" },
        },
        required: ["act_id", "part"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sections",
      description:
        "Return the full verbatim text of up to 10 sections by section_id, e.g. NTA-2025-s9. " +
        "Schedule item_ids from list_levies (e.g. TLA-1998-sch-III-1) are accepted too.",
      parameters: {
        type: "object",
        properties: {
          section_ids: { type: "array", items: { type: "string" }, maxItems: MAX_GET_SECTIONS },
        },
        required: ["section_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_levies",
      description:
        "List every item the Taxes and Levies (Approved List for Collection) Act 1998 Schedule gives one tier to collect: " +
        "federal (Part I), state (Part II) or lga (Part III). Returns item_id, part, item_no and the item's full verbatim text.",
      parameters: {
        type: "object",
        properties: { tier: { type: "string", enum: LEVY_TIERS } },
        required: ["tier"],
      },
    },
  },
];

let promptCache: string | undefined;
function systemPrompt(): string {
  if (promptCache) return promptCache;
  // src/agents/prompts when run from source; the cwd fallback covers the compiled dist/ build
  const candidates = [
    fileURLToPath(new URL("./prompts/researcher.md", import.meta.url)),
    resolve(process.cwd(), "src/agents/prompts/researcher.md"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Researcher prompt src/agents/prompts/researcher.md not found");
  promptCache = readFileSync(found, "utf-8").replace("{{MAP_OF_ACTS}}", formatToc(tocEntries()));
  return promptCache;
}

/** Exported for tests: the system prompt with the Map of the Acts filled in. */
export const researcherSystemPrompt = systemPrompt;

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export type SqlGuard = { ok: true; sql: string } | { ok: false; error: string };

/**
 * Accept only a single read-only SELECT over taxmap.sections / taxmap.acts. Caps the row count
 * at 40, and rewrites plain section searches to the standard columns so every row is citable.
 */
export function guardSql(input: string): SqlGuard {
  const sql = input.trim();
  if (!sql) return { ok: false, error: "Empty SQL." };
  if (sql.includes(";")) return { ok: false, error: "Semicolons are not allowed: send exactly one statement without ';'." };
  if (!/^select\b/i.test(sql)) return { ok: false, error: "Only SELECT statements are allowed." };

  const bare = sql.replace(/'(?:[^']|'')*'/g, "''"); // keyword checks must ignore string literals
  if (/\b(insert|update|delete|drop|create|alter|truncate|merge|grant|revoke|cache|uncache|refresh|show|describe)\b/i.test(bare)) {
    return { ok: false, error: "Only read-only SELECT queries are allowed." };
  }
  const tables = [...bare.matchAll(/\b(?:from|join)\s+([A-Za-z_][\w.]*)/gi)].map((m) => (m[1] ?? "").toLowerCase());
  if (tables.length === 0 || tables.some((t) => !TABLES.has(t))) {
    return { ok: false, error: "Query only taxmap.sections or taxmap.acts (fully qualified)." };
  }

  let out = sql;
  const simple = /^select\s+([\s\S]+?)\s+from\s+taxmap\.sections\b([\s\S]*)$/i.exec(out);
  if (
    simple &&
    !/\b(count|sum|avg|min|max)\s*\(|\bdistinct\b/i.test(simple[1] ?? "") &&
    !/\b(group\s+by|join|union|select)\b/i.test(simple[2] ?? "")
  ) {
    out = `SELECT section_id, act_id, section_no, heading, tier, text FROM taxmap.sections${simple[2]}`;
  }

  const limit = /\blimit\s+(\d+)\s*$/i.exec(out);
  if (!limit) out = `${out} LIMIT ${SQL_ROW_LIMIT}`;
  else if (Number(limit[1]) > SQL_ROW_LIMIT) out = out.replace(/\blimit\s+\d+\s*$/i, `LIMIT ${SQL_ROW_LIMIT}`);
  return { ok: true, sql: out };
}

type Row = Record<string, unknown>;

function toRows(columns: string[], rows: unknown[][], snippet: boolean): Row[] {
  return rows.map((r) => {
    const rec: Row = {};
    columns.forEach((c, i) => {
      rec[c] = r[i] ?? null;
    });
    if (snippet && typeof rec.text === "string") {
      rec.snippet = rec.text.slice(0, SNIPPET_CHARS);
      delete rec.text;
    }
    if (rec.section_id == null && rec.act_id != null && rec.section_no != null) {
      rec.section_id = `${String(rec.act_id)}-s${String(rec.section_no)}`;
    }
    return rec;
  });
}

interface ToolOutcome {
  content: string;
  detail: Record<string, unknown>;
  rows: Row[];
}

const toolError = (tool: string, error: string, extra: Record<string, unknown> = {}): ToolOutcome => ({
  content: JSON.stringify({ error }),
  detail: { tool, error, ...extra },
  rows: [],
});

async function execTool(call: ToolCall): Promise<ToolOutcome> {
  const tool = call.function.name;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return toolError(tool, "Tool arguments were not valid JSON.");
  }

  try {
    if (tool === "run_sql") {
      if (typeof args.sql !== "string") return toolError(tool, "run_sql needs a string argument 'sql'.");
      const guard = guardSql(args.sql);
      if (!guard.ok) return toolError(tool, guard.error, { sql_requested: args.sql });
      const res = await runSql(guard.sql);
      const rows = toRows(res.columns, res.rows, true);
      return {
        content: JSON.stringify({ row_count: rows.length, rows }),
        detail: { tool, sql_requested: args.sql, sql_run: guard.sql, row_count: rows.length },
        rows,
      };
    }

    if (tool === "browse_part") {
      if (typeof args.act_id !== "string") return toolError(tool, "browse_part needs act_id.");
      const str = (v: unknown) => (typeof v === "string" ? v : null);
      const found = findPart(tocEntries(), args.act_id, str(args.chapter), str(args.part));
      const label = `${args.act_id} ${str(args.chapter) ?? ""} ${str(args.part) ?? ""}`.replace(/\s+/g, " ").trim();
      if (!found.ok) return toolError(tool, found.error, { requested: label });
      const e = found.entry;
      const where = [
        `act_id = ${sqlString(e.act_id)}`,
        e.chapter === null ? "chapter IS NULL" : `chapter = ${sqlString(e.chapter)}`,
        e.part === null ? "part IS NULL" : `part = ${sqlString(e.part)}`,
      ].join(" AND ");
      const sql = `SELECT section_id, section_no, heading FROM taxmap.sections WHERE ${where} ORDER BY CAST(section_no AS INT)`;
      const res = await runSql(sql);
      const rows = toRows(res.columns, res.rows, false);
      return {
        content: JSON.stringify({ act_id: e.act_id, chapter: e.chapter, part: e.part, sections: rows }),
        detail: { tool, requested: label, sql_run: sql, row_count: rows.length },
        rows,
      };
    }

    if (tool === "get_sections") {
      const ids = sectionIdList(args.section_ids);
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === "string")) {
        return toolError(tool, "get_sections needs a non-empty array of section_id strings.");
      }
      if (ids.length > MAX_GET_SECTIONS) return toolError(tool, `At most ${MAX_GET_SECTIONS} section_ids per call.`);
      const bad = ids.filter((id) => !SECTION_ID_RE.test(id) && !isItemId(id));
      if (bad.length) return toolError(tool, `Not valid section_ids: ${bad.join(", ")}. Expected e.g. NTA-2025-s9 or TLA-1998-sch-III-1.`);
      // sections come from taxmap.sections, Schedule items from taxmap.levies
      const sectionIds = ids.filter((id) => !isItemId(id));
      const itemIds = ids.filter(isItemId);
      const queries: string[] = [];
      const rows: Row[] = [];
      if (sectionIds.length) {
        const sql = `SELECT section_id, act_id, section_no, heading, tier, text FROM taxmap.sections WHERE section_id IN (${sectionIds.map(sqlString).join(", ")})`;
        const res = await runSql(sql);
        queries.push(sql);
        rows.push(...toRows(res.columns, res.rows, false));
      }
      if (itemIds.length) {
        const sql = `SELECT ${LEVY_SELECT} FROM taxmap.levies WHERE item_id IN (${itemIds.map(sqlString).join(", ")})`;
        const res = await runSql(sql);
        queries.push(sql);
        rows.push(...levyRows(res.columns, res.rows));
      }
      const found = new Set(rows.map((r) => String(r.section_id)));
      const missing = ids.filter((id) => !found.has(id));
      return {
        content: JSON.stringify({ sections: rows, ...(missing.length ? { not_found: missing } : {}) }),
        detail: { tool, requested: ids, sql_run: queries.join("\n"), row_count: rows.length, not_found: missing },
        rows,
      };
    }

    if (tool === "list_levies") {
      const tier = args.tier;
      if (typeof tier !== "string" || !LEVY_TIERS.includes(tier as LevyTier)) {
        return toolError(tool, "list_levies needs tier: federal, state or lga.");
      }
      const sql = `SELECT ${LEVY_SELECT} FROM taxmap.levies WHERE tier = ${sqlString(tier)} ORDER BY CAST(item_no AS INT)`;
      const res = await runSql(sql);
      const rows = levyRows(res.columns, res.rows);
      const items = rows.map((r) => ({ item_id: r.item_id, part: r.part, item_no: r.item_no, text: r.text }));
      return {
        content: JSON.stringify({ tier, part_title: rows[0]?.part_title ?? null, items }),
        detail: { tool, requested: tier, sql_run: sql, row_count: rows.length },
        rows,
      };
    }
  } catch (err) {
    return toolError(tool, `Query failed: ${err instanceof Error ? err.message : String(err)}`, {
      sql_requested: args.sql,
      requested: args.section_ids,
    });
  }
  return toolError(tool, `Unknown tool '${tool}'. Use browse_part, run_sql, get_sections or list_levies.`);
}

/**
 * The section_ids argument as a list. The model sometimes sends the array as a string ("[NTA-2025-s56, NTAA-2025-s22]"
 * or a JSON string); in a live run nine such calls in a row were rejected. Anything else is returned as given.
 */
export function sectionIdList(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // not JSON: split below
  }
  const ids = v.split(/[\s,;[\]"']+/).filter(Boolean);
  return ids.length ? ids : v;
}

const LEVY_SELECT = "item_id, act_id, part, part_title, tier, item_no, text";

/**
 * Schedule items as citable rows: `section_id` is the item_id (so citing, reading and the Critic treat
 * an item like a section), `heading` names its place in the Schedule and the Part's own heading.
 */
export function levyRows(columns: string[], rows: unknown[][]): Row[] {
  return toRows(columns, rows, false).map((r) => {
    const itemId = String(r.item_id ?? "");
    return {
      section_id: itemId,
      item_id: itemId,
      act_id: r.act_id,
      part: r.part as LevyPart,
      part_title: r.part_title,
      item_no: String(r.item_no ?? ""),
      heading: itemHeading({ item_id: itemId, part_title: String(r.part_title ?? "") }),
      tier: r.tier,
      text: r.text,
    };
  });
}

const EXEMPTION_WORDING = /\b(?:exempt|not (?:required|liable|obliged|chargeable)|does not apply|shall not apply|need not|is not subject)\b/i;

/** The claim type the model gave, or (if it left it out) inferred from the wording. */
export function claimType(given: string | undefined, text: string): ClaimType {
  if (given === "obligation" || given === "exemption") return given;
  return EXEMPTION_WORDING.test(text) ? "exemption" : "obligation";
}

const ClaimSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["obligation", "exemption"]).optional(),
    text: z.string().min(1),
    // optional: a missing or blank plain line falls back to the legal sentence on the page
    plain: z
      .string()
      .nullable()
      .optional()
      .transform((v) => (v ?? "").replace(/\s+/g, " ").trim()),
    section_ids: z.array(z.string()),
    tier: z.enum(["federal", "state", "lga"]),
    agency: z
      .string()
      .nullable()
      .optional()
      .transform((v) => v ?? null),
  })
  .transform((c) => ({ ...c, type: claimType(c.type, c.text) }));
const DraftSchema = z.object({
  claims: z.array(ClaimSchema),
  notes: z.array(z.string()).default([]),
  unanswered: z.array(z.string()).default([]),
});

export type DraftParse = { ok: true; draft: Draft } | { ok: false; error: string };

export function parseDraft(content: string | null): DraftParse {
  let text = (content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "No JSON object found in the reply." };
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = DraftSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, error: `JSON does not match the Draft shape: ${issues.join("; ")}` };
  }
  return { ok: true, draft: parsed.data };
}

interface MemoryContent {
  tool: string;
  label: string;
  row_count: number;
  sections: Array<{ section_id: string; heading: string; snippet: string }>;
}

interface RunState {
  seen: Set<string>;
  fetched: Set<string>;
  queries: string[];
  excerpts: Map<string, { heading: string; snippet: string }>;
  /** Every tool call that ran (repeats excluded): its SQL or label and its row count, for the drafting digest. */
  queryLog: Array<{ query: string; rows: number }>;
  /** Tiers list_levies has returned; the model re-called it for the same tier in a live run. */
  levyTiers: Set<string>;
}

const DIGEST_SQL_CHARS = 300;
const DIGEST_SECTION_CHARS = 300;

/**
 * What a drafting or revision turn is given in place of the raw tool results: per query its SQL and row
 * count, per section read in full its id, heading and first 300 characters.
 */
export function drafterDigest(queryLog: Array<{ query: string; rows: number }>, read: Record<string, SectionRead>): string {
  const lines = ["Digest of the tool results so far (the raw results are not repeated):", "Queries run (SQL, rows):"];
  for (const q of queryLog) {
    const sql = q.query.replace(/\s+/g, " ").trim();
    lines.push(`- ${sql.length > DIGEST_SQL_CHARS ? `${sql.slice(0, DIGEST_SQL_CHARS)}…` : sql} -> ${q.rows} ${q.rows === 1 ? "row" : "rows"}`);
  }
  if (!queryLog.length) lines.push("- none");
  lines.push("Sections read in full (id, heading, first 300 characters):");
  const ids = Object.keys(read);
  for (const id of ids) {
    const r = read[id] as SectionRead;
    lines.push(`- ${id}${r.heading ? ` (${r.heading})` : ""}: ${r.text.replace(/\s+/g, " ").slice(0, DIGEST_SECTION_CHARS)}`);
  }
  if (!ids.length) lines.push("- none");
  return lines.join("\n");
}

/**
 * The full text of the sections most likely to be cited, as revision turns carry it: at most
 * REVISION_MAX_SECTIONS, each cut to REVISION_TEXT_CHARS. Sections the draft already cites come first,
 * then the rest by `score`.
 */
export function candidateTexts(read: Record<string, SectionRead>, cited: string[], score: (r: Row) => number): Row[] {
  const rows: Row[] = Object.entries(read).map(([section_id, r]) => ({ section_id, heading: r.heading, text: r.text }));
  return revisionTexts(rows, (r) => (cited.includes(String(r.section_id)) ? 1_000_000 : 0) + score(r));
}

function alreadyFound(entries: ScoredMemoryEntry[], st: RunState, turn: number, lastTurn: boolean): string {
  const { seen, fetched, queries } = st;
  const lines = [
    `Turn ${turn} of ${MAX_TURNS}.`,
    "Already found (summary of earlier tool results; they are not repeated in full):",
  ];
  for (const e of entries) {
    const c = e.content as Partial<MemoryContent>;
    if (!Array.isArray(c.sections)) continue; // not a tool-result summary
    const secs = c.sections
      .slice(0, 15)
      .map((s) => (s.heading ? `${s.section_id} (${s.heading})` : s.section_id))
      .join("; ");
    // H-MEM carries tool results across runs: those sections are known, but must be fetched again to cite
    const origin = e.origin === "earlier_run" ? " [from an earlier run: fetch again before citing]" : "";
    lines.push(`- ${c.tool} ${c.label}: ${c.row_count} rows${secs ? `: ${secs}` : ""}${origin}`);
  }
  lines.push(`Section ids seen so far (you may cite only these): ${[...seen].join(", ") || "none"}`);
  lines.push(`Sections already read in full with get_sections: ${[...fetched].join(", ") || "none"}`);
  if (st.levyTiers.size) {
    lines.push(`list_levies already called for: ${[...st.levyTiers].join(", ")}. Those items are read in full (listed above); do not call it again for that tier.`);
  }
  if (queries.length) lines.push(`Queries already run (do not repeat them):\n${queries.map((q) => `  ${q}`).join("\n")}`);

  if (lastTurn) {
    // the final turn carries no tool history: the digest and candidate texts follow (see draftingContext)
    lines.push("This is your final turn and tools are disabled. Reply now with only the Draft JSON object.");
  } else if (turn >= MAX_TURNS - 3) {
    lines.push(
      `Only ${MAX_TURNS - turn} turns remain. Stop searching: call get_sections on the sections you will cite, then reply with the Draft JSON.`,
    );
  }
  return lines.join("\n");
}

function taskMessage(profile: Profile, question: string): string {
  return [
    PROFILE_HEADER,
    JSON.stringify(profile, null, 2),
    "",
    `Question: ${question}`,
    "",
    "Search the loaded statutes with the tools, read every section you will cite with get_sections, then reply with the Draft JSON.",
    "",
    "Before deciding whether an obligation applies, check the Act's definitions and any threshold or exemption provisions " +
      "relevant to the profile (for example, provisions that define a small company or exempt small businesses) and cite them. " +
      "If a section you have read contains a subsection that disapplies the rule for this profile, say so in the claim text " +
      "or move the point to notes.",
    ...levySteer(profile),
  ].join("\n");
}

/**
 * For a business with signage or premises, a pointer to Part III of the Schedule (what the local
 * government may collect). It names the kind of item, never an item number, so the model reads the list.
 */
export function levySteer(profile: Profile): string[] {
  const has = [profile.has_signage && "signage", profile.has_premises && "business premises"].filter(Boolean);
  if (!has.length) return [];
  return [
    "",
    `This business has ${has.join(" and ")}. Cover the checklist areas in the Acts first (browse the Map of the Acts, read the sections). ` +
      `Then call list_levies once with tier "lga" and check Part III of the Schedule of the ` +
      "Taxes and Levies (Approved List for Collection) Act for permit and premises items that may apply to it. " +
      "Draft a claim only for an item whose subject matches a fact about this business, name that fact in the claim, " +
      "cite the item by its item_id, and say only that the local government may collect it.",
  ];
}

const REPEAT_PREFIX = "ALREADY RUN; use browse_part or get_sections instead";
const MAX_REPEATS = 2;

/**
 * A comparison key for run_sql: case and whitespace folded, LIMIT ignored, ILIKE and lower(col)
 * LIKE treated alike, and the terms of a flat OR list sorted. Nested AND/OR logic keeps its order.
 */
export function canonicalSql(sql: string): string {
  let s = sql.toLowerCase().replace(/\s+/g, " ").trim();
  s = s.replace(/\s+limit\s+\d+$/, "");
  s = s.replace(/\bilike\b/g, "like").replace(/lower\(\s*([\w.]+)\s*\)/g, "$1");
  const m = /^(.*? where )(.*?)( order by .*)?$/.exec(s);
  if (!m) return s;
  const terms = (m[2] ?? "").split(/ or /).map((t) => t.trim());
  if (terms.some((t) => /\band\b|[()]/.test(t))) return s;
  return `${m[1]}${[...new Set(terms)].sort().join(" or ")}${m[3] ?? ""}`;
}

const DASH = "[‐-―−-]"; // hyphen, non-breaking hyphen, en/em dashes, minus
const NOTE_ID_RE = new RegExp(`\\b(NTA|NTAA|NRSEA|JRBEA|TLA)\\s*${DASH}\\s*(2025|1998)\\s*${DASH}\\s*s(\\d+)\\b`, "gi");
const NOTE_ITEM_RE = new RegExp(`\\bTLA\\s*${DASH}\\s*1998\\s*${DASH}\\s*sch\\s*${DASH}\\s*(I|II|III)\\s*${DASH}\\s*(\\d+)\\b`, "gi");
const NOTE_RANGE_RE = new RegExp(`\\bs(\\d+)\\s*${DASH}\\s*s?(\\d+)\\b`, "gi");
const NOTE_ACT_RE = /\b(NTA|NTAA|NRSEA|JRBEA|TLA)\b/gi;
/** The act_id for the short name a note uses. */
const NOTE_ACT_ID = (name: string) => (name === "TLA" ? "TLA-1998" : `${name}-2025`);

/** Section numbers per Act, from the parsed sections. */
function actSections(): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const e of tocEntries()) {
    const set = out.get(e.act_id) ?? new Set<number>();
    for (let n = e.first; n <= e.last; n++) set.add(n);
    out.set(e.act_id, set);
  }
  return out;
}

/** True when every section in a range like "s143-s150" was read, in the Act named before it or, if none is named, in some Act. */
function rangeRead(note: string, at: number, lo: number, hi: number, fetched: Set<string>): boolean {
  const acts = actSections();
  const named = [...note.slice(0, at).matchAll(NOTE_ACT_RE)].at(-1)?.[1]?.toUpperCase();
  const candidates = named ? [NOTE_ACT_ID(named)] : [...acts.keys()];
  return candidates.some((act) => {
    const ids = [...(acts.get(act) ?? [])].filter((n) => n >= lo && n <= hi).map((n) => `${act}-s${n}`);
    return ids.length > 0 && ids.every((id) => fetched.has(id));
  });
}

/**
 * Revision turns (coverage revision and read-before-cite revision) show at most this many sections,
 * this long each: with up to 24 sections at 3,000 characters, Lightning returned empty responses
 * (HTTP 502) even at an 8,000-token cap.
 */
export const REVISION_MAX_SECTIONS = 8;
export const REVISION_TEXT_CHARS = 1_500;

/** The highest-scoring rows (ties keep fetch order), at most REVISION_MAX_SECTIONS, text cut to REVISION_TEXT_CHARS. */
export function revisionTexts(rows: Row[], score: (r: Row) => number): Row[] {
  return rows
    .map((r, i) => ({ r, i, s: score(r) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, REVISION_MAX_SECTIONS)
    .map(({ r }) => {
      const text = String(r.text ?? "");
      return { ...r, text: text.length > REVISION_TEXT_CHARS ? `${text.slice(0, REVISION_TEXT_CHARS)} [truncated]` : text };
    });
}

/** Relevance to the uncovered areas: matches of each area's wording, counted five times in the heading. */
export function areaScore(areas: ChecklistArea[]): (r: Row) => number {
  return (r) =>
    areas.reduce((n, a) => {
      const re = new RegExp(a.wording.source, "gi");
      return n + 5 * (String(r.heading ?? "").match(re)?.length ?? 0) + (String(r.text ?? "").match(re)?.length ?? 0);
    }, 0);
}

const ABSENCE_RE = /not found|not loaded|no sections|does not define|is present|not covered|not present|no definition|not defined/i;
const NOTE_STOPWORDS = new Set(["about", "after", "these", "their", "there", "which", "would", "could", "under", "loaded", "found", "sections", "section"]);
const significantWords = (s: string) =>
  new Set((s.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((w) => !NOTE_STOPWORDS.has(w)));

/**
 * Drops model notes that assert an absence ("not found", "not loaded", "no sections", "does not define")
 * unless an unanswered entry covers the same point: both fall under the same checklist area, or they
 * share at least two significant words.
 */
export function filterAbsenceNotes(notes: string[], unanswered: string[], profile: Profile): string[] {
  const areas = checklistAreas(profile);
  return notes.filter((n) => {
    if (!ABSENCE_RE.test(n)) return true;
    const words = significantWords(n);
    return unanswered.some(
      (u) =>
        areas.some((a) => a.wording.test(n) && a.wording.test(u)) ||
        [...significantWords(u)].filter((w) => words.has(w)).length >= 2,
    );
  });
}

/** Replaces any note that names a section_id, or a range of sections, the run did not read in full. */
export function filterNotes(notes: string[], fetched: Set<string>): string[] {
  return notes.map((n) => {
    const ids = [
      ...[...n.matchAll(NOTE_ID_RE)].map((m) => `${(m[1] ?? "").toUpperCase()}-${m[2]}-s${m[3]}`),
      ...[...n.matchAll(NOTE_ITEM_RE)].map((m) => `TLA-1998-sch-${(m[1] ?? "").toUpperCase()}-${m[2]}`),
    ];
    const ranges = [...n.matchAll(NOTE_RANGE_RE)].map((m) => {
      const a = Number(m[1]);
      const b = Number(m[2]);
      return { at: m.index ?? 0, lo: Math.min(a, b), hi: Math.max(a, b) };
    });
    const unread =
      ids.some((id) => !fetched.has(id)) || ranges.some((r) => !rangeRead(n, r.at, r.lo, r.hi, fetched));
    return unread ? "note removed: unread section" : n;
  });
}

const now = () => new Date().toISOString();

/**
 * Research which statute sections create obligations for the business and draft cited claims.
 * Every citation in the returned draft was read in full with get_sections during this run: when the
 * model drafts from search snippets, the agent fetches the cited sections itself and gives the model
 * one turn to revise the draft against the full text.
 */
export interface ResearchOptions {
  /** Targeted turns for uncovered checklist areas (default true). */
  coverage?: boolean;
  /** Called with each trace step as it is recorded, for live progress. */
  onTrace?: (step: TraceStep) => void;
}

export async function research(
  profile: Profile,
  question: string,
  memory: RunMemory,
  options: ResearchOptions = {},
): Promise<ResearchResult> {
  const trace = observedTrace(options.onTrace);
  const receipts: Receipt[] = [];
  const st: RunState = { seen: new Set(), fetched: new Set(), queries: [], excerpts: new Map(), queryLog: [], levyTiers: new Set() };
  const { seen, fetched } = st;
  const notes: string[] = [];
  const task = taskMessage(profile, question);
  let lastExchange: ChatMessage[] = [];
  let correctionUsed = false;
  let verifyUsed = false;
  let toolsOff = false; // set for the revision turn that follows an agent fetch
  let draft: Draft | undefined;
  let fallback: Draft | undefined; // the pre-verification draft, if the revision cannot be parsed
  const sectionsRead: Record<string, SectionRead> = {};
  const toolResults = new Map<string, string>(); // repeat key -> tool result content
  let repeats = 0;
  let finalEarly = false; // set after MAX_REPEATS repeated calls
  let coverageDone = options.coverage === false;
  const targetedAreas: string[] = []; // checklist keys that got a targeted turn

  /**
   * The repeat key of a run_sql (canonicalSql) or get_sections (the id set, order-insensitive) call,
   * with the earlier result if the same call already ran.
   */
  function repeatOf(call: ToolCall): { key: string; earlier?: string } | undefined {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      return undefined;
    }
    let key: string;
    if (call.function.name === "run_sql" && typeof args.sql === "string") {
      const guard = guardSql(args.sql);
      if (!guard.ok) return undefined;
      key = `sql:${canonicalSql(guard.sql)}`;
    } else if (call.function.name === "get_sections" && Array.isArray(sectionIdList(args.section_ids))) {
      key = `get:${[...new Set((sectionIdList(args.section_ids) as string[]).map(String))].sort().join(",")}`;
    } else if (call.function.name === "list_levies" && typeof args.tier === "string") {
      key = `levies:${args.tier}`;
    } else {
      return undefined;
    }
    return { key, earlier: toolResults.get(key) };
  }

  async function runTool(call: ToolCall, by: "model" | "agent"): Promise<ToolOutcome> {
    trace.push({
      kind: "tool_call",
      ts: now(),
      detail: { id: call.id, name: call.function.name, arguments: call.function.arguments, by },
    });
    const rep = repeatOf(call);
    if (rep?.earlier !== undefined) {
      repeats++;
      if (repeats >= MAX_REPEATS) finalEarly = true;
      const prior = JSON.parse(rep.earlier) as { row_count?: number; sections?: unknown[]; items?: unknown[] };
      const rowCount = prior.row_count ?? prior.sections?.length ?? prior.items?.length ?? 0;
      const tool = call.function.name;
      trace.push({ kind: "tool_result", ts: now(), detail: { tool, repeat: repeats, row_count: rowCount, by } });
      return { content: `${REPEAT_PREFIX}\n${rep.earlier}`, detail: { tool, repeat: repeats }, rows: [] };
    }
    const out = await execTool(call);
    if (rep && !out.detail.error) toolResults.set(rep.key, out.content);
    // list_levies returns each Schedule item's full text, so its items count as read in full
    const readsInFull = call.function.name === "get_sections" || call.function.name === "list_levies";
    if (call.function.name === "list_levies" && !out.detail.error) st.levyTiers.add(String(out.detail.requested));
    if (readsInFull) {
      for (const r of out.rows) {
        if (typeof r.section_id !== "string") continue;
        sectionsRead[r.section_id] = {
          heading: String(r.heading ?? ""),
          text: String(r.text ?? ""),
          act_id: String(r.act_id ?? ""),
          section_no: String(r.section_no ?? r.item_no ?? ""),
        };
      }
    }
    trace.push({ kind: "tool_result", ts: now(), detail: { ...out.detail, by } });
    st.queryLog.push({
      query: String(out.detail.sql_run ?? out.detail.sql_requested ?? `${call.function.name} ${String(out.detail.requested ?? "")}`.trim()),
      rows: out.rows.length,
    });
    const ids = out.rows.map((r) => r.section_id).filter((x): x is string => typeof x === "string");
    ids.forEach((id) => seen.add(id));
    if (readsInFull) ids.forEach((id) => fetched.add(id));
    if (typeof out.detail.sql_requested === "string") st.queries.push(out.detail.sql_requested);
    for (const r of out.rows) {
      if (typeof r.section_id !== "string") continue;
      const prev = st.excerpts.get(r.section_id);
      const snippet = String(r.snippet ?? r.text ?? "").slice(0, 300);
      if (!prev || (!prev.snippet && snippet)) st.excerpts.set(r.section_id, { heading: String(r.heading ?? ""), snippet });
    }
    await memory.store({
      kind: "tool_result",
      content: {
        tool: call.function.name,
        label: String(out.detail.sql_requested ?? out.detail.requested ?? ""),
        row_count: out.rows.length,
        sections: out.rows.map((r) => ({
          section_id: String(r.section_id ?? ""),
          heading: String(r.heading ?? ""),
          snippet: String(r.snippet ?? r.text ?? "").slice(0, 300),
        })),
      } satisfies MemoryContent,
      tags: [call.function.name, ...ids],
    });
    return out;
  }

  /**
   * A tool-free drafting or revision call. It first tries max_tokens DRAFT_MAX_TOKENS with no retry; if
   * that fails, it tries once more at DRAFT_RETRY_MAX_TOKENS. Lightning reasons before it answers, and a
   * 4,000-token cap can run out mid-reasoning: Nightshift then answers HTTP 502 with
   * "<model>_empty_response", which an identical retry would only repeat.
   */
  async function draftChat(messages: ChatMessage[]): Promise<ChatResult> {
    try {
      return await chat({ messages, max_tokens: DRAFT_MAX_TOKENS }, { timeoutMs: RESEARCHER_TIMEOUT_MS, retries: 0 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      trace.push({ kind: "model_turn", ts: now(), detail: { phase: "draft_retry", error: msg.slice(0, 200), next_max_tokens: DRAFT_RETRY_MAX_TOKENS } });
      return chat({ messages, max_tokens: DRAFT_RETRY_MAX_TOKENS }, { timeoutMs: RESEARCHER_TIMEOUT_MS, retries: 1 });
    }
  }

  /**
   * The context of a drafting or revision turn in place of raw tool results: the digest, and (unless the
   * turn already carries revision texts) the full text of at most 8 candidate sections at 1,500 characters,
   * the ones the earlier draft cites first, then the ones most relevant to the checklist areas.
   */
  function draftingContext(cited: string[], withTexts: boolean): string {
    const parts = [drafterDigest(st.queryLog, sectionsRead)];
    if (withTexts) {
      const texts = candidateTexts(sectionsRead, cited, areaScore(checklistAreas(profile)));
      if (texts.length) {
        parts.push(`Full text of the sections most likely to be cited (at most ${REVISION_MAX_SECTIONS}, first ${REVISION_TEXT_CHARS} characters each):\n${JSON.stringify(texts)}`);
      }
    }
    return parts.join("\n\n");
  }

  /** What the run has read so far, for the coverage turns (which do not carry the tool history). */
  function readSoFar(): string {
    const ids = [...fetched];
    const lines = ids.map((id) => `- ${id}${st.excerpts.get(id)?.heading ? ` (${st.excerpts.get(id)?.heading})` : ""}`);
    return `Sections already read in full:\n${lines.join("\n") || "none"}`;
  }

  /**
   * Checklist enforcement: one targeted turn per area no claim covers (unanswered entries do not count)
   * (at most MAX_COVERAGE_TURNS), naming the
   * area and its Parts from the map, with the agent's own browse of those Parts. The model fetches the
   * deciding sections; one tool-free drafting turn then revises the draft from what was fetched.
   * Returns the revised draft, or undefined when every area is covered or nothing could be revised.
   */
  async function coveragePass(current: Draft): Promise<Draft | undefined> {
    const missing = uncoveredAreas(current.claims, profile).slice(0, MAX_COVERAGE_TURNS);
    if (missing.length === 0) return undefined;
    const fetchedNow: Row[] = [];
    const levyLines: string[] = []; // Schedule items listed for area (f), shown whole to the revision turn
    let working = current;

    for (const area of missing) {
      targetedAreas.push(area.key);
      const parts = areaParts(area);
      const listing: string[] = [];
      if (area.levies) {
        for (const tier of ["state", "lga"] as const) {
          const out = await runTool(
            { id: `agent_levies_${tier}`, type: "function", function: { name: "list_levies", arguments: JSON.stringify({ tier }) } },
            "agent",
          );
          const lines = out.rows.map((r) => `${String(r.section_id)}: ${String(r.text ?? "")}`);
          levyLines.push(...lines.map((l) => `- ${l}`));
          listing.push(`Schedule, Part ${String(out.rows[0]?.part ?? "")} (${String(out.rows[0]?.part_title ?? tier)}):\n  ${lines.join("\n  ")}`);
        }
      }
      for (const [i, e] of parts.entries()) {
        const out = await runTool(
          {
            id: `agent_browse_${area.key}_${i + 1}`,
            type: "function",
            function: {
              name: "browse_part",
              arguments: JSON.stringify({ act_id: e.act_id, chapter: e.chapter ?? "(none)", part: e.part ?? "(none)" }),
            },
          },
          "agent",
        );
        const secs = out.rows.map((r) => `${String(r.section_id)}${r.heading ? ` ${String(r.heading)}` : ""}`);
        listing.push(`${e.act_id} ${[e.chapter, e.part].filter(Boolean).join(" / ")}:\n  ${secs.join("\n  ")}`);
      }
      const ask =
        `Checklist area (${area.key}) ${area.label} is not covered by any claim in your draft (above). An entry in unanswered does not count.\n` +
        `Relevant Parts from the Map of the Acts: ${describeParts(parts)}.\n\nSections in those Parts:\n${listing.join("\n")}\n\n` +
        "Call get_sections once with the sections (at most 6) that decide this area for this business, including any " +
        "interpretation section whose definitions the area turns on. Do not draft yet: you will revise the draft next." +
        (area.levies ? " The Schedule items listed are already read in full: cite them by item_id without fetching them again." : "");
      const res = await chat(
        {
          messages: [
            { role: "system", content: systemPrompt() },
            { role: "user", content: `${task}\n\n${readSoFar()}` },
            { role: "assistant", content: JSON.stringify(working) },
            { role: "user", content: ask },
          ],
          tools: TOOLS,
          tool_choice: "auto",
        },
        { timeoutMs: RESEARCHER_TIMEOUT_MS },
      );
      receipts.push(res.receipt);
      const calls = res.message.tool_calls ?? [];
      trace.push({
        kind: "model_turn",
        ts: now(),
        detail: { phase: "coverage", area: area.key, tool_calls: calls.map((c) => c.function.name), content: (res.message.content ?? "").slice(0, 300) },
        receipt: res.receipt,
      });
      for (const call of calls) {
        const out = await runTool(call, "model");
        if (call.function.name === "get_sections") fetchedNow.push(...out.rows);
      }
      if (calls.length === 0) {
        const p = parseDraft(res.message.content); // the model drafted straight away
        if (p.ok) working = p.draft;
      }
    }

    const byId = new Map(fetchedNow.map((r) => [String(r.section_id), r]));
    const texts = revisionTexts([...byId.values()], areaScore(missing));
    const reviseMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: `${task}\n\n${draftingContext([], false)}` }, // the revision message below carries the texts
      { role: "assistant", content: JSON.stringify(working) },
      {
        role: "user",
        content:
          `You were asked to cover these checklist areas: ${missing.map((a) => `(${a.key}) ${a.label}`).join("; ")}. ` +
          "The full text of the sections fetched for them is below. Reply with the complete revised Draft JSON: keep your " +
          "existing claims, add a claim (obligation or exemption) for each of these areas the text settles for this business, " +
          "citing the sections and the definitions it turns on, and for any area the text does not settle add an entry to " +
          "unanswered saying what you looked for. Reply with only the Draft JSON.\n\n" +
          JSON.stringify(texts) +
          (levyLines.length
            ? "\n\nSchedule items of the Taxes and Levies (Approved List for Collection) Act 1998, read in full. Cite an item by its " +
              "item_id; a claim on one is made only for an item whose subject matches this business, names the profile fact it " +
              "rests on, says only that the authority may collect the levy, and states no amount:\n" +
              levyLines.join("\n")
            : ""),
      },
    ];
    // one correction when the revision does not parse, as in the main loop; then keep the earlier draft
    for (let attempt = 1; attempt <= 2; attempt++) {
      let res: ChatResult;
      try {
        res = await draftChat(reviseMessages);
      } catch (err) {
        // the targeted searches are not lost: their sections are read, and the revision turn can still use them
        notes.push(`Coverage revision failed (${err instanceof Error ? err.message.slice(0, 120) : String(err)}); kept the draft from before it.`);
        return working === current ? undefined : working;
      }
      receipts.push(res.receipt);
      trace.push({
        kind: "model_turn",
        ts: now(),
        detail: { phase: attempt === 1 ? "coverage_draft" : "coverage_correction", tool_calls: [], content: (res.message.content ?? "").slice(0, 300) },
        receipt: res.receipt,
      });
      const p = parseDraft(res.message.content);
      if (p.ok) return p.draft;
      if (attempt === 2) {
        notes.push(`Coverage revision could not be parsed after one correction (${p.error}); kept the draft from before it.`);
        break;
      }
      reviseMessages.push(
        { role: "assistant", content: res.message.content ?? "" },
        {
          role: "user",
          content: `${p.error} Reply again with only a single JSON object of the form {"claims": [...], "notes": [...], "unanswered": [...]} and no other text.`,
        },
      );
    }
    return working === current ? undefined : working;
  }

  // The final turn comes at MAX_TURNS, or earlier after MAX_REPEATS repeated tool calls. Every path on
  // it ends the loop except the single correction and the single
  // verification turn, so a run makes at most MAX_TURNS + 2 model calls.
  for (let turn = 1; ; turn++) {
    const lastTurn = turn >= MAX_TURNS || finalEarly;
    const noTools = lastTurn || toolsOff;
    toolsOff = false;
    let userContent = task;
    if (turn > 1) {
      const found = await memory.retrieve(question, 5);
      userContent = `${task}\n\n${alreadyFound(found, st, turn, lastTurn)}`;
      // drafting and revision turns get a digest, not raw tool results; after the read-before-cite
      // revision the exchange already carries the texts, so only the digest is added
      if (noTools) userContent += `\n\n${draftingContext((fallback ?? draft)?.claims.flatMap((c) => c.section_ids) ?? [], !verifyUsed)}`;
    }
    // Turns without tools also leave out tool-call history: in a live run the model kept emitting
    // tool calls under tool_choice "none" and even with no tools in the request.
    const history = noTools ? lastExchange.filter((m) => m.role !== "tool" && !m.tool_calls) : lastExchange;
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userContent },
      ...history,
    ];

    // tool-free turns are drafting or revision turns, which get the capped draftChat
    const res = noTools
      ? await draftChat(messages)
      : await chat({ messages, tools: TOOLS, tool_choice: "auto" }, { timeoutMs: RESEARCHER_TIMEOUT_MS });
    receipts.push(res.receipt);
    const calls = res.message.tool_calls ?? [];
    trace.push({
      kind: "model_turn",
      ts: now(),
      detail: { turn, tool_calls: calls.map((c) => c.function.name), content: (res.message.content ?? "").slice(0, 300) },
      receipt: res.receipt,
    });

    if (calls.length > 0 && !noTools) {
      const toolMessages: ChatMessage[] = [];
      for (const call of calls) {
        const out = await runTool(call, "model");
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: out.content });
      }
      lastExchange = [{ role: "assistant", content: res.message.content ?? null, tool_calls: calls }, ...toolMessages];
      continue;
    }

    const parsed: DraftParse =
      calls.length > 0
        ? { ok: false, error: "Tools are disabled on this turn; your reply was a tool call." }
        : parseDraft(res.message.content);

    if (parsed.ok) {
      let current = parsed.draft;
      let currentContent = res.message.content ?? "";
      if (!coverageDone) {
        // once per run, before the revision turn: targeted turns for checklist areas with no claim
        coverageDone = true;
        const revised = await coveragePass(current);
        if (revised) {
          current = revised;
          currentContent = JSON.stringify(revised);
        }
      }
      const unread = [...new Set(current.claims.flatMap((c) => c.section_ids))].filter(
        (id) => seen.has(id) && !fetched.has(id),
      );
      if (unread.length === 0 || verifyUsed) {
        draft = current;
        break;
      }
      // The draft cites sections known only from search snippets: fetch them and let the model
      // check its claims against the full text before answering.
      verifyUsed = true;
      fallback = current;
      const sections: Row[] = [];
      for (let i = 0; i < unread.length; i += MAX_GET_SECTIONS) {
        const batch = unread.slice(i, i + MAX_GET_SECTIONS);
        const out = await runTool(
          {
            id: `agent_fetch_${i / MAX_GET_SECTIONS + 1}`,
            type: "function",
            function: { name: "get_sections", arguments: JSON.stringify({ section_ids: batch }) },
          },
          "agent",
        );
        sections.push(...out.rows);
      }
      // most relevant first: words shared with the claims that cite the section
      const texts = revisionTexts(sections, (r) => {
        const citing = current.claims.filter((c) => c.section_ids.includes(String(r.section_id)));
        const hay = significantWords(`${String(r.heading ?? "")} ${String(r.text ?? "")}`);
        return [...significantWords(citing.map((c) => c.text).join(" "))].filter((w) => hay.has(w)).length;
      });
      lastExchange = [
        { role: "assistant", content: currentContent },
        {
          role: "user",
          content:
            "You cited sections you had not read in full. Their full text is below. Check every claim against the text: " +
            "keep a claim only if the text supports it as it applies to this business, correct it where the text says " +
            "something different (for example an exemption for small businesses), and remove it otherwise. " +
            "Notes must only describe sections you have read in full; the agent will verify this and remove any note " +
            "that names another section. Reply with only the revised Draft JSON.\n\n" +
            JSON.stringify(texts),
        },
      ];
      toolsOff = true;
      continue;
    }

    if (correctionUsed) {
      notes.push(`Model reply could not be parsed after one correction: ${parsed.error}`);
      if (fallback) notes.push("Kept the draft from before verification.");
      draft = fallback;
      break;
    }
    correctionUsed = true;
    // a failed revision keeps the full-text exchange so the retry can still use it, and stays tool-free
    toolsOff = verifyUsed;
    lastExchange = [
      ...(verifyUsed ? lastExchange : []),
      { role: "assistant", content: res.message.content ?? "" },
      {
        role: "user",
        content: `${parsed.error} Reply again with only a single JSON object of the form {"claims": [...], "notes": [...], "unanswered": [...]} and no other text.`,
      },
    ];
  }

  const result: Draft = draft ?? { claims: [], notes: [], unanswered: [question] };
  const unseen: string[] = [];
  const unread: string[] = [];
  const claims = result.claims.map((c) => {
    const ids = [...new Set(c.section_ids)];
    for (const id of ids) {
      if (!seen.has(id)) unseen.push(`${c.id}:${id}`);
      else if (!fetched.has(id)) unread.push(`${c.id}:${id}`);
    }
    return { ...c, section_ids: ids.filter((id) => fetched.has(id)) };
  });
  const uncited = claims.filter((c) => c.section_ids.length === 0).map((c) => c.id);
  if (unseen.length) notes.push(`Dropped section_ids not seen in any tool result: ${unseen.join(", ")}`);
  if (unread.length) notes.push(`Dropped section_ids not read in full with get_sections: ${unread.join(", ")}`);
  if (uncited.length) notes.push(`Dropped claims left without a citation read in full: ${uncited.join(", ")}`);

  // levy claims: one per Schedule item, each naming a profile fact, at most MAX_LEVY_CLAIMS
  const limited = limitLevyClaims(claims.filter((c) => c.section_ids.length > 0), profile);
  notes.push(...limited.notes);
  const kept = limited.claims;
  const stillUncovered = uncoveredAreas(kept, profile).map((a) =>
    targetedAreas.includes(a.key)
      ? `Checklist (${a.key}) ${a.label}: no claim after a targeted search of ${describeParts(areaParts(a))}.`
      : `Checklist (${a.key}) ${a.label}: not searched in a targeted turn (limit of ${MAX_COVERAGE_TURNS} targeted turns reached).`,
  );

  const unanswered = [...result.unanswered, ...stillUncovered];
  const modelNotes = filterAbsenceNotes(filterNotes(result.notes, fetched), unanswered, profile);
  const removedAbsence = result.notes.length - modelNotes.length;
  if (removedAbsence > 0) {
    notes.push(`Removed ${removedAbsence} note(s) saying something was not found or not loaded, with no matching unanswered entry.`);
  }

  return {
    draft: {
      claims: kept,
      notes: [...modelNotes, ...notes],
      unanswered,
    },
    trace,
    receipts,
    sections_read: sectionsRead,
  };
}
