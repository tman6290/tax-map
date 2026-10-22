import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runSql } from "../data/zetaris.js";
import type { RunMemory, ScoredMemoryEntry } from "../engines/types.js";
import { chat, type ChatMessage, type Receipt, type ToolCall, type ToolDefinition } from "../providers/meterless.js";
import type { Draft, Profile, ResearchResult, TraceStep } from "./types.js";

export const MAX_TURNS = 8;
const SQL_ROW_LIMIT = 40;
const SNIPPET_CHARS = 500;
const MAX_GET_SECTIONS = 10;
const SECTION_ID_RE = /^(?:NTA|NTAA|NRSEA|JRBEA)-2025-s\d+$/;
const TABLES = new Set(["taxmap.sections", "taxmap.acts"]);

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
      name: "get_sections",
      description: "Return the full verbatim text of up to 10 sections by section_id, e.g. NTA-2025-s9.",
      parameters: {
        type: "object",
        properties: {
          section_ids: { type: "array", items: { type: "string" }, maxItems: MAX_GET_SECTIONS },
        },
        required: ["section_ids"],
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
  promptCache = readFileSync(found, "utf-8");
  return promptCache;
}

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

    if (tool === "get_sections") {
      const ids = args.section_ids;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === "string")) {
        return toolError(tool, "get_sections needs a non-empty array of section_id strings.");
      }
      if (ids.length > MAX_GET_SECTIONS) return toolError(tool, `At most ${MAX_GET_SECTIONS} section_ids per call.`);
      const bad = ids.filter((id) => !SECTION_ID_RE.test(id));
      if (bad.length) return toolError(tool, `Not valid section_ids: ${bad.join(", ")}. Expected e.g. NTA-2025-s9.`);
      const list = ids.map((id) => `'${id}'`).join(", ");
      const sql = `SELECT section_id, act_id, section_no, heading, tier, text FROM taxmap.sections WHERE section_id IN (${list})`;
      const res = await runSql(sql);
      const rows = toRows(res.columns, res.rows, false);
      const found = new Set(rows.map((r) => String(r.section_id)));
      const missing = ids.filter((id) => !found.has(id));
      return {
        content: JSON.stringify({ sections: rows, ...(missing.length ? { not_found: missing } : {}) }),
        detail: { tool, requested: ids, sql_run: sql, row_count: rows.length, not_found: missing },
        rows,
      };
    }
  } catch (err) {
    return toolError(tool, `Query failed: ${err instanceof Error ? err.message : String(err)}`, {
      sql_requested: args.sql,
      requested: args.section_ids,
    });
  }
  return toolError(tool, `Unknown tool '${tool}'. Use run_sql or get_sections.`);
}

const ClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  section_ids: z.array(z.string()),
  tier: z.enum(["federal", "state", "lga"]),
  agency: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});
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
}

const FINAL_EXCERPTS = 30;

function alreadyFound(entries: ScoredMemoryEntry[], st: RunState, turn: number): string {
  const { seen, fetched, queries } = st;
  const lastTurn = turn >= MAX_TURNS;
  const lines = [
    `Turn ${turn} of ${MAX_TURNS}.`,
    "Already found (summary of earlier tool results; they are not repeated in full):",
  ];
  for (const e of entries) {
    const c = e.content as MemoryContent;
    const secs = c.sections
      .slice(0, 15)
      .map((s) => (s.heading ? `${s.section_id} (${s.heading})` : s.section_id))
      .join("; ");
    lines.push(`- ${c.tool} ${c.label}: ${c.row_count} rows${secs ? `: ${secs}` : ""}`);
  }
  lines.push(`Section ids seen so far (you may cite only these): ${[...seen].join(", ") || "none"}`);
  lines.push(`Sections already read in full with get_sections: ${[...fetched].join(", ") || "none"}`);
  if (queries.length) lines.push(`Queries already run (do not repeat them):\n${queries.map((q) => `  ${q}`).join("\n")}`);

  if (lastTurn) {
    // the final turn carries no tool history, so give the model short excerpts to draft from
    const ex = [...st.excerpts].slice(0, FINAL_EXCERPTS);
    lines.push("Excerpts of the sections seen (first 300 characters each):");
    for (const [id, e] of ex) lines.push(`- ${id}${e.heading ? ` (${e.heading})` : ""}: ${e.snippet}`);
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
    "Business profile (turnover bands are annual turnover in naira):",
    JSON.stringify(profile, null, 2),
    "",
    `Question: ${question}`,
    "",
    "Search the loaded statutes with the tools, read every section you will cite with get_sections, then reply with the Draft JSON.",
  ].join("\n");
}

const now = () => new Date().toISOString();

/** Longest section text sent in a verification message; a few NTA sections exceed 20,000 characters. */
const VERIFY_TEXT_CHARS = 6_000;

/**
 * Research which statute sections create obligations for the business and draft cited claims.
 * Every citation in the returned draft was read in full with get_sections during this run: when the
 * model drafts from search snippets, the agent fetches the cited sections itself and gives the model
 * one turn to revise the draft against the full text.
 */
export async function research(profile: Profile, question: string, memory: RunMemory): Promise<ResearchResult> {
  const trace: TraceStep[] = [];
  const receipts: Receipt[] = [];
  const st: RunState = { seen: new Set(), fetched: new Set(), queries: [], excerpts: new Map() };
  const { seen, fetched } = st;
  const notes: string[] = [];
  const task = taskMessage(profile, question);
  let lastExchange: ChatMessage[] = [];
  let correctionUsed = false;
  let verifyUsed = false;
  let toolsOff = false; // set for the revision turn that follows an agent fetch
  let draft: Draft | undefined;
  let fallback: Draft | undefined; // the pre-verification draft, if the revision cannot be parsed

  async function runTool(call: ToolCall, by: "model" | "agent"): Promise<ToolOutcome> {
    trace.push({
      kind: "tool_call",
      ts: now(),
      detail: { id: call.id, name: call.function.name, arguments: call.function.arguments, by },
    });
    const out = await execTool(call);
    trace.push({ kind: "tool_result", ts: now(), detail: { ...out.detail, by } });
    const ids = out.rows.map((r) => r.section_id).filter((x): x is string => typeof x === "string");
    ids.forEach((id) => seen.add(id));
    if (call.function.name === "get_sections") ids.forEach((id) => fetched.add(id));
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

  // Every path at turn >= MAX_TURNS ends the loop except the single correction and the single
  // verification turn, so a run makes at most MAX_TURNS + 2 model calls.
  for (let turn = 1; ; turn++) {
    const lastTurn = turn >= MAX_TURNS;
    const noTools = lastTurn || toolsOff;
    toolsOff = false;
    let userContent = task;
    if (turn > 1) {
      const found = await memory.retrieve(question, 5);
      userContent = `${task}\n\n${alreadyFound(found, st, turn)}`;
    }
    // Turns without tools also leave out tool-call history: in a live run the model kept emitting
    // tool calls under tool_choice "none" and even with no tools in the request.
    const history = noTools ? lastExchange.filter((m) => m.role !== "tool" && !m.tool_calls) : lastExchange;
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userContent },
      ...history,
    ];

    const res = await chat(noTools ? { messages } : { messages, tools: TOOLS, tool_choice: "auto" });
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
      const unread = [...new Set(parsed.draft.claims.flatMap((c) => c.section_ids))].filter(
        (id) => seen.has(id) && !fetched.has(id),
      );
      if (unread.length === 0 || verifyUsed) {
        draft = parsed.draft;
        break;
      }
      // The draft cites sections known only from search snippets: fetch them and let the model
      // check its claims against the full text before answering.
      verifyUsed = true;
      fallback = parsed.draft;
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
      const texts = sections.map((r) => {
        const text = String(r.text ?? "");
        return { ...r, text: text.length > VERIFY_TEXT_CHARS ? `${text.slice(0, VERIFY_TEXT_CHARS)} [truncated]` : text };
      });
      lastExchange = [
        { role: "assistant", content: res.message.content ?? "" },
        {
          role: "user",
          content:
            "You cited sections you had not read in full. Their full text is below. Check every claim against the text: " +
            "keep a claim only if the text supports it as it applies to this business, correct it where the text says " +
            "something different (for example an exemption for small businesses), and remove it otherwise. " +
            "Reply with only the revised Draft JSON.\n\n" +
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

  return {
    draft: {
      claims: claims.filter((c) => c.section_ids.length > 0),
      notes: [...result.notes, ...notes],
      unanswered: result.unanswered,
    },
    trace,
    receipts,
  };
}
