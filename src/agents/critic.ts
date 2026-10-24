import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { WorldModel } from "../engines/types.js";
import { chatWithFallback, type ChatMessage, type Receipt } from "../providers/index.js";
import { corpus, isGlossarySection, matchDefinitions, type CorpusSection, type GlossaryEntry } from "./glossary.js";
import { PROFILE_HEADER } from "./profile.js";
import { observedTrace } from "./trace.js";
import type { CheckedClaim, Claim, ClaimType, CritiqueResult, Draft, Profile, SectionRead, TraceStep, Verdict } from "./types.js";

export const CRITIC_APP = "taxmap-critic";
const DEFAULT_CRITIC_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const QUOTE_NOT_FOUND = "quote not found in cited text: ";
const NOT_ESTABLISHED = "text does not establish the claim";
/** Critic calls get longer than the 60 s default: Nightshift 1.2.3 allows up to 120 s to first token on cloud lanes. */
const CRITIC_TIMEOUT_MS = 150_000;
/** Piece size when a call fails with HTTP 502: a 1,944-character section that failed whole passed in 800-character pieces. */
const FALLBACK_PIECE_CHARS = 800;

/** Longest piece of operative text per Critic call; a normal section is judged whole. */
export function pieceChars(): number {
  const n = Number(process.env.CRITIC_PIECE_CHARS);
  return Number.isInteger(n) && n >= 200 ? n : 6_000;
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
  // "silent" is accepted from older replies and treated as not_established
  struck_because: z
    .enum(["disapplies", "contradicts", "not_established", "silent"])
    .nullable()
    .optional()
    .transform((v) => (v === "silent" ? "not_established" : (v ?? null))),
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

/**
 * Folding used for the grounding check: dashes and whitespace normalised, and double quotation marks
 * dropped, because definitions put them round every term ("small business" means ...) and models
 * copying a definition routinely leave them out. Every other character must still match.
 */
export function normaliseForQuote(s: string): string {
  return s
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‛′]/g, "'")
    .replace(/["“”‟″]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const FRAGMENT_SEPARATOR = " … ";
const MIN_FRAGMENT_CHARS = 20;
const MAX_FRAGMENTS = 4;

/**
 * True when the quote is grounded in one of the texts: either one contiguous excerpt (ignoring a
 * leading or trailing ellipsis), or 2-4 fragments joined by " … " that are each at least 20 characters,
 * verbatim, all in the same text, and in document order. Anything else fails.
 */
export function quoteInTexts(quote: string | null, texts: string[]): boolean {
  if (!quote) return false;
  const q = normaliseForQuote(quote)
    .replace(/^["'\s]*(?:\.\.\.|…)?\s*/, "")
    .replace(/\s*(?:\.\.\.|…)?["'\s]*$/, "");
  const normalised = texts.map(normaliseForQuote);
  if (!q.includes(FRAGMENT_SEPARATOR)) {
    if (q.length < 8) return false; // too short to ground anything
    return normalised.some((t) => t.includes(q));
  }
  const fragments = q.split(FRAGMENT_SEPARATOR).map((f) => f.trim());
  if (fragments.length > MAX_FRAGMENTS || fragments.some((f) => f.length < MIN_FRAGMENT_CHARS)) return false;
  return normalised.some((t) => {
    let from = 0;
    for (const f of fragments) {
      const at = t.indexOf(f, from);
      if (at < 0) return false;
      from = at + f.length;
    }
    return true;
  });
}

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

interface Piece {
  section_id: string;
  heading: string;
  text: string;
  label: string;
  /** "piece i of n" when the section is split, else "" */
  position: string;
}

function piecesOf(id: string, heading: string, text: string, max: number, labelPrefix = id): Piece[] {
  const parts = packPieces(splitSubsections(text), max);
  return parts.map((t, i) => ({
    section_id: id,
    heading,
    text: t,
    label: parts.length > 1 ? `${labelPrefix} ${i + 1}/${parts.length}` : labelPrefix,
    position: parts.length > 1 ? `piece ${i + 1} of ${parts.length}` : "",
  }));
}

function userMessage(profile: Profile, claim: Claim, defs: GlossaryEntry[], piece: Piece): string {
  const parts = [
    PROFILE_HEADER,
    JSON.stringify(profile, null, 2),
    "",
    `Claim type: ${claim.type ?? "obligation"} (${claim.type === "exemption" ? "the claim says a rule does NOT apply to this business" : "the claim says a rule applies to this business"})`,
    `Claim: ${claim.text}`,
  ];
  if (defs.length) {
    parts.push("", "Definitions (authoritative for the terms they define):");
    for (const d of defs) parts.push("", `--- ${d.section_id} "${d.term}"`, d.definition);
  }
  const of = piece.position ? ` (${piece.position}; other pieces are judged separately)` : "";
  parts.push("", "Operative text:", "", `--- ${piece.section_id}${piece.heading ? `: ${piece.heading}` : ""}${of}`, piece.text);
  return parts.join("\n");
}

const now = () => new Date().toISOString();

export interface PieceResult {
  label: string;
  verdict: Verdict;
  struck_because: "disapplies" | "contradicts" | "not_established" | null;
  reason: string;
  quote: string | null;
  quote_verified: boolean;
  qualifier: string | null;
  receipt: Receipt | null;
  /** set when the call failed with HTTP 502, so the piece can be judged again in smaller pieces */
  status502?: boolean;
}

const DECISIVE_REASON = /disappl|does not apply|shall not apply|not appl(?:y|icable) to|exempt|contradict|inconsistent|exclud/i;
const DISAPPLYING_QUOTE = /shall not apply|does not apply|not applicable|is exempt|are exempt|exempt(?:ed)? from|shall not be (?:liable|required|chargeable)/i;

/**
 * A strike that removes or contradicts the claim, rather than one where the text simply does not
 * establish it. The no-silent rule: a struck piece whose verified quote is itself a disapplying
 * sentence counts as decisive whatever label the model gave it.
 */
function decisive(p: PieceResult, type: ClaimType): boolean {
  if (p.verdict !== "struck") return false;
  if (p.struck_because === "disapplies" || p.struck_because === "contradicts") return true;
  // for an exemption claim a disapplying sentence is the evidence for the claim, not against it
  if (type === "obligation" && p.quote_verified && p.quote && DISAPPLYING_QUOTE.test(p.quote)) return true;
  return p.struck_because === null && DECISIVE_REASON.test(p.reason);
}

/**
 * Merges per-piece verdicts: a decisive strike wins, then any qualified piece, then (if some piece
 * could not be checked) unchecked, then a supported piece with a verified quote; otherwise struck.
 */
export function mergePieces(
  pieces: PieceResult[],
  type: ClaimType = "obligation",
): Omit<CheckedClaim, "claim" | "definitions_used" | "definitions"> {
  const pick = (p: PieceResult, verdict: Verdict = p.verdict) => ({
    verdict,
    reason: pieces.length > 1 ? `[${p.label}] ${p.reason}` : p.reason,
    quote: p.quote,
    quote_verified: p.quote_verified,
    qualifier: verdict === "qualified" ? p.qualifier : null,
    receipt: p.receipt,
  });
  const strike = pieces.find((p) => decisive(p, type));
  if (strike) return pick(strike, "struck");
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
    reason: "None of the cited sections, read in full, supports this line.",
    quote: null,
    quote_verified: false,
    qualifier: null,
    receipt: pieces.at(-1)?.receipt ?? null,
  };
}

/** A cited section with its chapter and part, preferring the text the Researcher read. */
function sectionContext(id: string, read: SectionRead | undefined): CorpusSection | undefined {
  const c = corpus().get(id);
  if (!read) return c;
  return {
    section_id: id,
    act_id: read.act_id,
    section_no: read.section_no,
    heading: read.heading,
    text: read.text,
    chapter: c?.chapter ?? null,
    part: c?.part ?? null,
  };
}

/**
 * Judge every drafted claim against the verbatim text of the sections it cites, with the glossary
 * definitions of the terms involved shown first. One model call per section (or per piece of a very
 * long section, or after an HTTP 502), plus at most one correction each. The Critic never adds claims.
 */
export interface CritiqueOptions {
  /** Called with each trace step as it is recorded, for live progress. */
  onTrace?: (step: TraceStep) => void;
  /** Called with each claim's verdict as soon as it is decided. */
  onChecked?: (checked: CheckedClaim) => void;
}

export async function critique(
  draft: Draft,
  sectionsRead: Record<string, SectionRead>,
  profile: Profile,
  world: WorldModel,
  options: CritiqueOptions = {},
): Promise<CritiqueResult> {
  const checked: CheckedClaim[] = [];
  const receipts: Receipt[] = [];
  const trace = observedTrace(options.onTrace);
  const model = process.env.METERLESS_CRITIC_MODEL || DEFAULT_CRITIC_MODEL;

  for (const claim of draft.claims) {
    const cited = claim.section_ids
      .map((id) => ({ id, section: sectionsRead[id] }))
      .filter((c): c is { id: string; section: SectionRead } => c.section !== undefined);
    const missing = claim.section_ids.filter((id) => sectionsRead[id] === undefined);

    // cited interpretation sections are context; a claim citing nothing else is judged on them
    const nonGlossary = cited.filter((c) => !isGlossarySection(c.id));
    const operative = nonGlossary.length ? nonGlossary : cited;
    const contexts = cited.map((c) => sectionContext(c.id, c.section)).filter((c): c is CorpusSection => c !== undefined);
    const defs = cited.length ? matchDefinitions(claim.text, contexts) : [];
    const definitionsUsed = [...new Set(defs.map((d) => d.section_id))];

    let result: Omit<CheckedClaim, "claim" | "definitions_used" | "definitions">;
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
      const results: PieceResult[] = [];
      for (const { id, section } of operative) {
        for (const piece of piecesOf(id, section.heading, section.text, pieceChars())) {
          const r = await judgePiece(claim, piece, defs, profile, model, receipts, trace);
          const smaller = r.status502 ? piecesOf(id, section.heading, piece.text, FALLBACK_PIECE_CHARS, piece.label) : [];
          if (smaller.length > 1) {
            // fallback: Nightshift answered 502 on this input, so judge it again in smaller pieces
            for (const p of smaller) results.push(await judgePiece(claim, p, defs, profile, model, receipts, trace));
          } else {
            results.push(r);
          }
        }
      }
      result = mergePieces(results, claim.type ?? "obligation");
    }
    const done: CheckedClaim = {
      claim,
      ...result,
      definitions_used: definitionsUsed,
      definitions: defs.map((d) => ({ section_id: d.section_id, term: d.term, definition: d.definition })),
    };
    checked.push(done);
    options.onChecked?.(done);

    for (const id of [...new Set([...claim.section_ids, ...definitionsUsed])]) {
      const s = sectionContext(id, sectionsRead[id]);
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
  defs: GlossaryEntry[],
  profile: Profile,
  model: string,
  receipts: Receipt[],
  trace: TraceStep[],
): Promise<PieceResult> {
  const label = piece.label;
  const base = { label, struck_because: null, quote: null, quote_verified: false, qualifier: null };
  const messages: ChatMessage[] = [
    { role: "system", content: criticSystemPrompt() },
    { role: "user", content: userMessage(profile, claim, defs, piece) },
  ];
  let receipt: Receipt | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Awaited<ReturnType<typeof chatWithFallback>>;
    try {
      res = await chatWithFallback({ messages, app: CRITIC_APP, model, temperature: 0 }, { timeoutMs: CRITIC_TIMEOUT_MS });
    } catch (err) {
      // chat has already retried: this piece could not be verified, which is not a rejection
      const msg = err instanceof Error ? err.message : String(err);
      trace.push({ kind: "model_turn", ts: now(), detail: { claim_id: claim.id, piece: label, attempt, verdict: "unchecked", error: msg } });
      return { ...base, verdict: "unchecked", reason: `critic call failed: ${msg}`, receipt, status502: /HTTP 502/.test(msg) };
    }
    receipt = res.receipt;
    receipts.push(res.receipt);

    const parsed = parseVerdict(res.message.content);
    if (!parsed.ok) {
      trace.push({
        kind: "model_turn",
        ts: now(),
        detail: { claim_id: claim.id, piece: label, attempt, verdict: "unparseable", content: (res.message.content ?? "").slice(-300) },
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
    const verified = quoteInTexts(v.quote, [piece.text, ...defs.map((d) => d.definition)]);
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
      out = { ...out, verdict: "struck", struck_because: "not_established", qualifier: null, reason: `${QUOTE_NOT_FOUND}${v.reason}` };
    } else if (out.struck_because === "not_established" && !out.reason.startsWith(NOT_ESTABLISHED)) {
      out = { ...out, reason: `${NOT_ESTABLISHED}: ${out.reason}` };
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
        definitions: defs.map((d) => `${d.section_id}:${d.term}`),
        content: (res.message.content ?? "").slice(-300),
      },
      receipt: res.receipt,
    });
    return out;
  }
  return { ...base, verdict: "struck", struck_because: "not_established", reason: "critic output unparseable", receipt };
}
