import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { WorldModel } from "../engines/types.js";
import { chatWithFallback, type ChatMessage, type Receipt } from "../providers/index.js";
import type { CheckedClaim, Claim, CritiqueResult, Draft, Profile, SectionRead, TraceStep, Verdict } from "./types.js";

export const CRITIC_APP = "taxmap-critic";
const DEFAULT_CRITIC_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
const QUOTE_NOT_FOUND = "quote not found in cited text: ";
const DEFINITIONS_CHARS = 2_000;

/**
 * Longest piece of operative text per Critic call. Nightshift answered HTTP 502 on long inputs
 * (a full 1,944-character NTAA-2025-s22 failed on every attempt; its first 600 characters passed),
 * so cited text is split at subsection boundaries and packed into pieces of at most this size.
 */
export function pieceChars(): number {
  const n = Number(process.env.CRITIC_PIECE_CHARS);
  return Number.isInteger(n) && n >= 200 ? n : 800; // 2,500 left s22 in one piece, which still failed; 800 passed
}

let promptCache: string | undefined;
export function criticSystemPrompt(): string {
  if (promptCache) return promptCache;
  const candidates = [
    fileURLToPath(new URL("./prompts/critic.md", import.meta.url)),
    resolve(process.cwd(), "src/agents/prompts/critic.md"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Critic prompt src/agents/prompts/critic.md not found");
  promptCache = readFileSync(found, "utf-8");
  return promptCache;
}

const optionalText = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v && v.trim() ? v : null));
const VerdictSchema = z.object({
  verdict: z.enum(["supported", "qualified", "struck"]),
  reason: z.string().min(1),
  quote: optionalText,
  qualifier: optionalText,
  struck_because: z.enum(["disapplies", "contradicts", "silent"]).nullable().optional(),
});
type ModelVerdict = z.infer<typeof VerdictSchema>;

type VerdictParse = { ok: true; value: ModelVerdict } | { ok: false; error: string };

export function parseVerdict(content: string | null): VerdictParse {
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
  const parsed = VerdictSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, error: `JSON does not match the verdict shape: ${issues.join("; ")}` };
  }
  return { ok: true, value: parsed.data };
}

/** Whitespace, dash and quote-mark folding used for the grounding check. */
export function normaliseForQuote(s: string): string {
  return s
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the quote (minus any leading/trailing ellipsis or quote marks) occurs in one of the texts. */
export function quoteInTexts(quote: string | null, texts: string[]): boolean {
  if (!quote) return false;
  const q = normaliseForQuote(quote)
    .replace(/^["'\s]*(?:\.\.\.|…)?\s*/, "")
    .replace(/\s*(?:\.\.\.|…)?["'\s]*$/, "");
  if (q.length < 8) return false; // too short to ground anything
  return texts.some((t) => normaliseForQuote(t).includes(q));
}

const isDefinitions = (s: SectionRead) => /interpret|definition|meaning of/i.test(s.heading);

/**
 * Splits section text before each subsection marker "(1)", "(2)", ... in sequence, so cross-references
 * such as "subsection (1)" inside the text are not mistaken for boundaries.
 */
export function splitSubsections(text: string): string[] {
  const cuts: number[] = [];
  let expected = 1;
  for (const m of text.matchAll(/(^|[\s.;:—–-])\((\d+)\)\s+(?=[A-Z"“])/g)) {
    if (Number(m[2]) !== expected) continue;
    cuts.push((m.index ?? 0) + (m[1] ?? "").length);
    expected++;
  }
  if (cuts.length < 2) return [text];
  const out: string[] = [];
  if ((cuts[0] ?? 0) > 0) out.push(text.slice(0, cuts[0]));
  cuts.forEach((c, i) => out.push(text.slice(c, cuts[i + 1] ?? text.length)));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Packs consecutive subsections into pieces of at most `max` characters; an oversize subsection is cut at sentence ends. */
export function packPieces(subs: string[], max: number): string[] {
  const out: string[] = [];
  let cur = "";
  const push = (s: string) => {
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${s}` : s;
  };
  for (const sub of subs) {
    if (sub.length <= max) {
      push(sub);
      continue;
    }
    let rest = sub;
    while (rest.length > max) {
      const cut = rest.lastIndexOf(". ", max);
      const at = cut > max / 2 ? cut + 1 : max;
      push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) push(rest);
  }
  if (cur) out.push(cur);
  return out;
}

/** The entries of an interpretation section whose defined term occurs in the claim or piece, else its start. */
export function relevantDefinitions(text: string, against: string): string {
  const entries = text.split(/(?=["“][^"”]{2,60}["”]\s+(?:means|includes|has the (?:same )?meaning|refers to))/);
  const lower = against.toLowerCase();
  const hits = entries.filter((e) => {
    const term = /^["“]([^"”]+)["”]/.exec(e)?.[1]?.toLowerCase();
    return term !== undefined && lower.includes(term);
  });
  const chosen = (hits.length ? hits.join(" ") : text).trim();
  return chosen.length > DEFINITIONS_CHARS ? `${chosen.slice(0, DEFINITIONS_CHARS)} [truncated]` : chosen;
}

interface Piece {
  section_id: string;
  heading: string;
  text: string;
  index: number;
  total: number;
}

function piecesFor(cited: Array<{ id: string; section: SectionRead }>, max: number): Piece[] {
  const out: Piece[] = [];
  for (const { id, section } of cited) {
    const parts = packPieces(splitSubsections(section.text), max);
    parts.forEach((text, i) => out.push({ section_id: id, heading: section.heading, text, index: i + 1, total: parts.length }));
  }
  return out;
}

function userMessage(profile: Profile, claim: Claim, defs: Array<{ id: string; heading: string; text: string }>, piece: Piece): string {
  const parts = [
    "Business profile (turnover bands are annual turnover in naira):",
    JSON.stringify(profile, null, 2),
    "",
    `Claim: ${claim.text}`,
  ];
  if (defs.length) {
    parts.push("", "Definitions (cited for the terms the claim depends on):");
    for (const d of defs) parts.push("", `--- ${d.id}${d.heading ? `: ${d.heading}` : ""}`, d.text);
  }
  const of = piece.total > 1 ? ` (piece ${piece.index} of ${piece.total}; other pieces are judged separately)` : "";
  parts.push("", "Operative text:", "", `--- ${piece.section_id}${piece.heading ? `: ${piece.heading}` : ""}${of}`, piece.text);
  return parts.join("\n");
}

const now = () => new Date().toISOString();

export interface PieceResult {
  label: string;
  verdict: Verdict;
  struck_because: "disapplies" | "contradicts" | "silent" | null;
  reason: string;
  quote: string | null;
  quote_verified: boolean;
  qualifier: string | null;
  receipt: Receipt | null;
}

const DECISIVE_REASON = /disappl|does not apply|shall not apply|not appl(?:y|icable) to|exempt|contradict|inconsistent|exclud/i;

/** True for a struck piece whose text removes or contradicts the claim, rather than being silent on it. */
function decisive(p: PieceResult): boolean {
  if (p.verdict !== "struck") return false;
  if (p.struck_because) return p.struck_because !== "silent";
  return DECISIVE_REASON.test(p.reason);
}

/**
 * Merges per-piece verdicts: a decisive strike wins, then any qualified piece, then (if some piece
 * could not be checked) unchecked, then a supported piece with a verified quote; otherwise struck.
 */
export function mergePieces(pieces: PieceResult[]): Omit<CheckedClaim, "claim"> {
  const pick = (p: PieceResult, verdict: Verdict = p.verdict) => ({
    verdict,
    reason: pieces.length > 1 ? `[${p.label}] ${p.reason}` : p.reason,
    quote: p.quote,
    quote_verified: p.quote_verified,
    qualifier: verdict === "qualified" ? p.qualifier : null,
    receipt: p.receipt,
  });
  const strike = pieces.find(decisive);
  if (strike) return pick(strike);
  const qualified = pieces.find((p) => p.verdict === "qualified");
  if (qualified) return pick(qualified);
  const failed = pieces.filter((p) => p.verdict === "unchecked");
  if (failed.length) {
    if (failed.length === pieces.length && failed[0]) return pick(failed[0]);
    return {
      verdict: "unchecked",
      reason: `${failed.length} of ${pieces.length} pieces could not be checked: ${failed.map((p) => p.label).join(", ")}`,
      quote: null,
      quote_verified: false,
      qualifier: null,
      receipt: null,
    };
  }
  const supported = pieces.find((p) => p.verdict === "supported" && p.quote_verified);
  if (supported) return pick(supported);
  if (pieces.length === 1 && pieces[0]) return pick(pieces[0]);
  return {
    verdict: "struck",
    reason: "no piece supports the claim",
    quote: null,
    quote_verified: false,
    qualifier: null,
    receipt: pieces.at(-1)?.receipt ?? null,
  };
}

/**
 * Judge every drafted claim against the verbatim text of the sections it cites: one model call per
 * piece of cited text (plus at most one correction each). The Critic never adds claims.
 */
export async function critique(
  draft: Draft,
  sectionsRead: Record<string, SectionRead>,
  profile: Profile,
  world: WorldModel,
): Promise<CritiqueResult> {
  const checked: CheckedClaim[] = [];
  const receipts: Receipt[] = [];
  const trace: TraceStep[] = [];
  const model = process.env.METERLESS_CRITIC_MODEL || DEFAULT_CRITIC_MODEL;

  for (const claim of draft.claims) {
    const cited = claim.section_ids
      .map((id) => ({ id, section: sectionsRead[id] }))
      .filter((c): c is { id: string; section: SectionRead } => c.section !== undefined);
    const missing = claim.section_ids.filter((id) => sectionsRead[id] === undefined);

    let result: Omit<CheckedClaim, "claim">;
    if (cited.length === 0) {
      // nothing to judge against; cannot happen for drafts from research(), which cites only sections read
      result = {
        verdict: "struck",
        reason: `cited section text not available: ${missing.join(", ")}`,
        quote: null,
        quote_verified: false,
        qualifier: null,
        receipt: null,
      };
    } else {
      // definition sections are context shown with every piece; a claim citing only definitions is judged on them
      const defSections = cited.filter((c) => isDefinitions(c.section));
      const operative = defSections.length < cited.length ? cited.filter((c) => !isDefinitions(c.section)) : cited;
      const defs = operative === cited ? [] : defSections;
      const pieces = piecesFor(operative, pieceChars());
      const results: PieceResult[] = [];
      for (const piece of pieces) {
        const shownDefs = defs.map((d) => ({
          id: d.id,
          heading: d.section.heading,
          text: relevantDefinitions(d.section.text, `${claim.text} ${piece.text}`),
        }));
        results.push(await judgePiece(claim, piece, shownDefs, profile, model, receipts, trace));
      }
      result = mergePieces(results);
    }
    checked.push({ claim, ...result });

    for (const id of claim.section_ids) {
      const s = sectionsRead[id];
      await world.addFact({
        section_id: id,
        act_id: s?.act_id ?? id.replace(/-s\d+$/, ""),
        section_no: s?.section_no ?? id.replace(/^.*-s/, ""),
        heading: s?.heading ?? "",
        text: s?.text ?? "",
        source: "taxmap.sections",
        verdict: result.verdict,
        claim_id: claim.id,
        reason: result.reason,
        quote: result.quote,
        ts: now(),
      });
    }
  }
  return { checked, receipts, trace };
}

async function judgePiece(
  claim: Claim,
  piece: Piece,
  defs: Array<{ id: string; heading: string; text: string }>,
  profile: Profile,
  model: string,
  receipts: Receipt[],
  trace: TraceStep[],
): Promise<PieceResult> {
  const label = piece.total > 1 ? `${piece.section_id} ${piece.index}/${piece.total}` : piece.section_id;
  const base = { label, struck_because: null, quote: null, quote_verified: false, qualifier: null };
  const messages: ChatMessage[] = [
    { role: "system", content: criticSystemPrompt() },
    { role: "user", content: userMessage(profile, claim, defs, piece) },
  ];
  let receipt: Receipt | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Awaited<ReturnType<typeof chatWithFallback>>;
    try {
      res = await chatWithFallback({ messages, app: CRITIC_APP, model, temperature: 0 });
    } catch (err) {
      // chat has already retried: this piece could not be verified, which is not a rejection
      const msg = err instanceof Error ? err.message : String(err);
      trace.push({ kind: "model_turn", ts: now(), detail: { claim_id: claim.id, piece: label, attempt, verdict: "unchecked", error: msg } });
      return { ...base, verdict: "unchecked", reason: `critic call failed: ${msg}`, receipt };
    }
    receipt = res.receipt;
    receipts.push(res.receipt);

    const parsed = parseVerdict(res.message.content);
    if (!parsed.ok) {
      trace.push({
        kind: "model_turn",
        ts: now(),
        detail: { claim_id: claim.id, piece: label, attempt, verdict: "unparseable", content: (res.message.content ?? "").slice(0, 300) },
        receipt: res.receipt,
      });
      messages.push(
        { role: "assistant", content: res.message.content ?? "" },
        {
          role: "user",
          content: `${parsed.error} Reply again with only one JSON object of the form {"verdict": "...", "reason": "...", "quote": "...", "qualifier": null, "struck_because": null} and no other text.`,
        },
      );
      continue;
    }

    const v = parsed.value;
    const verified = quoteInTexts(v.quote, [piece.text, ...defs.map((d) => d.text)]);
    let out: PieceResult = {
      label,
      verdict: v.verdict,
      struck_because: v.verdict === "struck" ? (v.struck_because ?? null) : null,
      reason: v.reason,
      quote: v.quote,
      quote_verified: verified,
      qualifier: v.verdict === "qualified" ? v.qualifier : null,
      receipt,
    };
    if ((out.verdict === "supported" || out.verdict === "qualified") && !verified) {
      out = { ...out, verdict: "struck", struck_because: "silent", qualifier: null, reason: `${QUOTE_NOT_FOUND}${v.reason}` };
    }
    trace.push({
      kind: "model_turn",
      ts: now(),
      detail: {
        claim_id: claim.id,
        piece: label,
        attempt,
        verdict: out.verdict,
        struck_because: out.struck_because,
        quote_verified: out.quote_verified,
        content: (res.message.content ?? "").slice(0, 300),
      },
      receipt: res.receipt,
    });
    return out;
  }
  return { ...base, verdict: "struck", struck_because: "silent", reason: "critic output unparseable", receipt };
}
