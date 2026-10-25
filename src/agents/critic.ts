// The Critic: judges each drafted claim against the verbatim text it cites, on Lane 2. The code, not the
// model, verifies every quote against the text, strikes levy claims that state an amount, splits long
// sections into pieces (smaller ones after an HTTP 502), and checks each plain-words line.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { WorldModel } from "../engines/types.js";
import { chatWithFallback, type ChatMessage, type Receipt } from "../providers/index.js";
import { collectorFor, type Collector } from "./collector.js";
import { corpus, isGlossarySection, matchDefinitions, type CorpusSection, type GlossaryEntry } from "./glossary.js";
import { citesLeviesAct, isItemId, LEVIES_ACT, statesAmount } from "./levies.js";
import { PROFILE_HEADER } from "./profile.js";
import { observedTrace } from "./trace.js";
import type { CheckedClaim, Claim, ClaimType, CritiqueResult, Draft, Profile, SectionRead, TraceStep, Verdict } from "./types.js";

export const CRITIC_APP = "taxmap-critic";
const DEFAULT_CRITIC_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const QUOTE_NOT_FOUND = "quote not found in cited text: ";
const NOT_ESTABLISHED = "text does not establish the claim";
/** Critic calls get longer than the 60 s default: Nightshift 1.2.3 allows up to 120 s to first token on cloud lanes. */
const CRITIC_TIMEOUT_MS = 150_000;
/** Profile band tokens as words, for reasons a business owner reads. */
const BAND_WORDS: Record<string, string> = {
  under_25m: "turnover under ₦25 million",
  "25m_to_100m": "turnover between ₦25 million and ₦100 million",
  over_100m: "turnover over ₦100 million",
  under_250m: "fixed assets under ₦250 million",
  over_250m: "fixed assets over ₦250 million",
};
/**
 * A band token, with the field name the model may put before it ("turnover band", "fixed_assets_band")
 * and a figure in brackets after it ("(≤ N25m)"), both absorbed so the words are not doubled.
 */
const BAND_TOKEN =
  /\b(?:(?:turnover|fixed[ _]assets)(?:[ _]band)?(?:\s*(?:of|is|=|:))?\s+)?(under_25m|25m_to_100m|over_100m|under_250m|over_250m)\b(?:\s*\([^()]*[N₦]\s?\d[^()]*\))?/gi;
/** Grounding-check prefixes the Critic adds to a reason; the trace keeps them, the page does not. */
const REASON_PREFIX = /^(?:\s*(?:quote not found in cited text|text does not establish the claim)\s*:\s*)+/i;

/**
 * The Why text a business owner reads: grounding-check prefixes removed and profile band tokens
 * (under_25m, over_250m, ...) written as words. Applied to each claim's final reason; the trace keeps
 * the raw reason.
 */
export function cleanReason(reason: string): string {
  const stripped = reason.replace(REASON_PREFIX, "");
  const text = stripped.replace(BAND_TOKEN, (_m, band: string) => BAND_WORDS[band.toLowerCase()] ?? band).trim();
  // the model's sentence started after the prefix, so it may start in lower case
  return stripped !== reason ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Why a claim citing the levies Act is struck when it, or its plain line, states an amount. */
export const AMOUNT_REASON =
  "amounts in this Act are 1998 maxima and may be superseded by State law; Tax Map does not assert them";

/** True when the claim cites the Taxes and Levies (Approved List for Collection) Act, a section or a Schedule item. */
export const citesLevies = (claim: Pick<Claim, "section_ids">) => claim.section_ids.some(citesLeviesAct);

/** True when a claim citing the levies Act states an amount of money in its legal sentence or its plain line. */
export function statesLevyAmount(claim: Pick<Claim, "section_ids" | "text" | "plain">): boolean {
  return citesLevies(claim) && (statesAmount(claim.text) || statesAmount(claim.plain ?? ""));
}

/** The plain-words check is one short call per claim, with no tools. */
const PLAIN_CHECK_TIMEOUT_MS = 60_000;

/** A claim's verdict before the definitions and the plain-words check are attached. */
type Judged = Omit<CheckedClaim, "claim" | "definitions_used" | "definitions" | "plain_checked" | "collector">;

/** Piece size when a call fails with HTTP 502: a 1,944-character section that failed whole passed in 800-character pieces. */
const FALLBACK_PIECE_CHARS = 800;

/** The Critic's model: METERLESS_CRITIC_MODEL, or Nemotron Ultra. */
export function criticModel(): string {
  return process.env.METERLESS_CRITIC_MODEL || DEFAULT_CRITIC_MODEL;
}

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

function userMessage(profile: Profile, claim: Claim, defs: GlossaryEntry[], piece: Piece, collector?: Collector): string {
  const parts = [
    PROFILE_HEADER,
    JSON.stringify(profile, null, 2),
    "",
    `Claim type: ${claim.type ?? "obligation"} (${claim.type === "exemption" ? "the claim says a rule does NOT apply to this business" : "the claim says a rule applies to this business"})`,
    `Claim: ${claim.text}`,
  ];
  if (collector && isItemId(piece.section_id)) {
    parts.push(`Collector: ${collector.authority} (tier: ${collector.tier})`);
    parts.push(
      "Question for this Schedule item: does the quoted item describe a levy that applies to this business given the profile, " +
        "and does the claim say only that the authority may collect it? Strike the claim if the item's subject does not match the profile.",
    );
  }
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
): Judged {
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
  /** Called with each claim's verdict once it is decided and every earlier claim's has been, so in the order of the draft. */
  onChecked?: (checked: CheckedClaim) => void;
}

/** Claims judged side by side; the plain-words check of one claim runs while the next claim's verdict does. */
export const CRITIC_CONCURRENCY = 4;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A claim whose verdict is in; its plain-words check is running. */
interface Verdicted {
  claim: Claim;
  result: Judged;
  defs: GlossaryEntry[];
  definitionsUsed: string[];
  collector: Collector;
  amountStruck: boolean;
  receipts: Receipt[];
  trace: TraceStep[];
  plain: Promise<{ plain: string; checked: boolean }>;
  plainReceipts: Receipt[];
  plainTrace: TraceStep[];
}

/** A claim's final form with the receipts and trace steps of its calls. */
interface ClaimOutcome {
  done: CheckedClaim;
  receipts: Receipt[];
  trace: TraceStep[];
}

export async function critique(
  draft: Draft,
  sectionsRead: Record<string, SectionRead>,
  profile: Profile,
  world: WorldModel,
  options: CritiqueOptions = {},
): Promise<CritiqueResult> {
  const model = criticModel();
  const claims = draft.claims;
  const outcomes = claims.map(() => deferred<ClaimOutcome>());
  outcomes.forEach((o) => o.promise.catch(() => undefined)); // a failure is raised once, by the ordered flush

  /**
   * The verdict phase of one claim. Its calls, receipts and trace steps go to buffers of their own, so
   * claims running side by side cannot interleave them. Starts the plain-words check when the verdict is
   * in and does not wait for it: the worker moves on to the next claim.
   */
  async function judgeClaim(claim: Claim): Promise<Verdicted> {
    const receipts: Receipt[] = [];
    const trace = observedTrace(options.onTrace);
    const plainReceipts: Receipt[] = [];
    const plainTrace = observedTrace(options.onTrace);
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

    const collector = collectorFor(claim, profile);
    const amountStruck = statesLevyAmount(claim);
    let result: Judged;
    if (amountStruck) {
      // decided without a model call: Tax Map never asserts a figure from the 1998 levies Act
      result = { verdict: "struck", reason: AMOUNT_REASON, quote: null, quote_verified: false, qualifier: null, receipt: null };
      trace.push({ kind: "model_turn", ts: now(), detail: { claim_id: claim.id, verdict: "struck", reason: AMOUNT_REASON, rule: "levy_amount" } });
    } else if (cited.length === 0) {
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
          const r = await judgePiece(claim, piece, defs, profile, model, receipts, trace, collector);
          const smaller = r.status502 ? piecesOf(id, section.heading, piece.text, FALLBACK_PIECE_CHARS, piece.label) : [];
          if (smaller.length > 1) {
            // fallback: Nightshift answered 502 on this input, so judge it again in smaller pieces
            for (const p of smaller) results.push(await judgePiece(claim, p, defs, profile, model, receipts, trace, collector));
          } else {
            results.push(r);
          }
        }
      }
      result = mergePieces(results, claim.type ?? "obligation");
    }
    const plain = amountStruck ? Promise.resolve({ plain: "", checked: false }) : checkPlain(claim, model, plainReceipts, plainTrace);
    return { claim, result, defs, definitionsUsed, collector, amountStruck, receipts, trace, plain, plainReceipts, plainTrace };
  }

  /** The plain-words check is back: the claim's final form. A fix may not bring a figure from the levies Act back. */
  async function finishClaim(v: Verdicted): Promise<ClaimOutcome> {
    const { claim, result, defs, definitionsUsed, collector } = v;
    let plainCheck = await v.plain;
    if (citesLevies(claim) && statesAmount(plainCheck.plain)) plainCheck = { plain: "", checked: false };
    const done: CheckedClaim = {
      claim: { ...claim, plain: plainCheck.plain },
      ...result,
      reason: cleanReason(result.reason),
      definitions_used: definitionsUsed,
      definitions: defs.map((d) => ({ section_id: d.section_id, term: d.term, definition: d.definition })),
      plain_checked: plainCheck.checked,
      collector,
    };
    return { done, receipts: [...v.receipts, ...v.plainReceipts], trace: [...v.trace, ...v.plainTrace] };
  }

  // a small pool of workers, each taking the next unjudged claim; a slot is held for the verdict only
  let next = 0;
  const worker = async () => {
    while (next < claims.length) {
      const i = next++;
      try {
        const verdicted = await judgeClaim(claims[i] as Claim);
        finishClaim(verdicted).then(outcomes[i]!.resolve, outcomes[i]!.reject);
      } catch (err) {
        outcomes[i]!.reject(err);
      }
    }
  };

  // results are released in claim order, whatever order the calls finish in: the returned arrays, the
  // onChecked events and the World Model facts all follow the order of the draft
  const checked: CheckedClaim[] = [];
  const receipts: Receipt[] = [];
  const trace: TraceStep[] = [];
  const flush = async () => {
    for (const [i, claim] of claims.entries()) {
      const { done, receipts: r, trace: t } = await (outcomes[i] as Deferred<ClaimOutcome>).promise;
      checked.push(done);
      receipts.push(...r);
      trace.push(...t);
      options.onChecked?.(done);
      for (const id of [...new Set([...claim.section_ids, ...done.definitions_used])]) {
        const s = sectionContext(id, sectionsRead[id]);
        await world.addFact({
          section_id: id,
          act_id: s?.act_id ?? (isItemId(id) ? LEVIES_ACT : id.replace(/-s\d+$/, "")),
          section_no: s?.section_no ?? id.replace(/^.*-(?:sch-[IVX]+-|s)/, ""),
          heading: s?.heading ?? "",
          text: s?.text ?? "",
          source: isItemId(id) ? "taxmap.levies" : "taxmap.sections",
          verdict: done.verdict,
          claim_id: claim.id,
          reason: done.reason,
          quote: done.quote,
          ts: now(),
        });
      }
    }
  };

  await Promise.all([flush(), ...Array.from({ length: Math.min(CRITIC_CONCURRENCY, claims.length) }, worker)]);
  return { checked, receipts, trace };
}

export const PLAIN_CHECK_PROMPT = [
  "You compare two sentences about Nigerian tax law. The legal sentence states what a statute requires of a business; the plain sentence restates it for the business owner.",
  "Does the plain sentence claim anything the legal sentence does not? Leaving out detail or using simpler words is fine. Adding a duty, deadline, amount, condition, exception or consequence is not, and neither is changing who must act or what they must do.",
  'Answer with one JSON object and nothing else: {"ok": boolean, "fix": string|null}.',
  'ok is true when the plain sentence claims nothing beyond the legal sentence; then fix is null. When ok is false, fix is a corrected plain sentence: one sentence, under 25 words, second person ("You need to…", "You don\'t have to…"), no legal terms, saying only what the legal sentence says.',
].join("\n\n");

const PlainCheckSchema = z.object({
  ok: z.boolean(),
  fix: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v ?? "").replace(/\s+/g, " ").trim()),
});

export type PlainCheckParse = { ok: true; value: { ok: boolean; fix: string } } | { ok: false; error: string };

/** Every balanced {...} span in `text`, in order, skipping braces inside JSON strings. */
function jsonObjectSpans(text: string): string[] {
  const spans: string[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        spans.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return spans;
}

/**
 * The first {ok, fix} object in the reply. The model sometimes follows the object with more text or
 * a second object, so each balanced object is tried in turn rather than first "{" to last "}".
 */
export function parsePlainCheck(content: string | null): PlainCheckParse {
  const text = (content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const spans = jsonObjectSpans(text);
  if (!spans.length) return { ok: false, error: "No JSON object found in the reply." };
  for (const span of spans) {
    try {
      const parsed = PlainCheckSchema.safeParse(JSON.parse(span));
      if (parsed.success) return { ok: true, value: parsed.data };
    } catch {
      // not JSON: try the next object
    }
  }
  return { ok: false, error: "No JSON object matching {ok, fix} in the reply." };
}

/**
 * One Critic-model call per claim, no tools, 60 s: does `plain` claim anything `text` does not? If it
 * does, the model's fix replaces it; a fix that is missing leaves no plain line (the page shows the
 * legal sentence). If the call fails or the reply cannot be read, the line is kept but not marked
 * checked, and the page shows the legal sentence alone.
 */
export async function checkPlain(
  claim: Claim,
  model: string,
  receipts: Receipt[],
  trace: TraceStep[],
): Promise<{ plain: string; checked: boolean }> {
  const plain = (claim.plain ?? "").trim();
  if (!plain) return { plain: "", checked: false };
  const messages: ChatMessage[] = [
    { role: "system", content: PLAIN_CHECK_PROMPT },
    { role: "user", content: `Legal sentence: ${claim.text}\nPlain sentence: ${plain}` },
  ];
  const step = (detail: Record<string, unknown>, receipt?: Receipt) =>
    trace.push({ kind: "model_turn", ts: now(), detail: { phase: "plain_check", claim_id: claim.id, ...detail }, ...(receipt ? { receipt } : {}) });
  let res: Awaited<ReturnType<typeof chatWithFallback>>;
  try {
    res = await chatWithFallback({ messages, app: CRITIC_APP, model, temperature: 0 }, { timeoutMs: PLAIN_CHECK_TIMEOUT_MS, retries: 0 });
  } catch (err) {
    step({ ok: null, error: err instanceof Error ? err.message : String(err) });
    return { plain, checked: false };
  }
  receipts.push(res.receipt);
  const parsed = parsePlainCheck(res.message.content);
  if (!parsed.ok) {
    step({ ok: null, error: parsed.error, content: (res.message.content ?? "").slice(0, 300) }, res.receipt);
    return { plain, checked: false };
  }
  if (parsed.value.ok) {
    step({ ok: true }, res.receipt);
    return { plain, checked: true };
  }
  step({ ok: false, original: plain, fix: parsed.value.fix || null }, res.receipt);
  return parsed.value.fix ? { plain: parsed.value.fix, checked: true } : { plain: "", checked: false };
}

async function judgePiece(
  claim: Claim,
  piece: Piece,
  defs: GlossaryEntry[],
  profile: Profile,
  model: string,
  receipts: Receipt[],
  trace: TraceStep[],
  collector?: Collector,
): Promise<PieceResult> {
  const label = piece.label;
  const base = { label, struck_because: null, quote: null, quote_verified: false, qualifier: null };
  const messages: ChatMessage[] = [
    { role: "system", content: criticSystemPrompt() },
    { role: "user", content: userMessage(profile, claim, defs, piece, collector) },
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
    // quote grounding: a supported or qualified verdict stands only if its quote is verbatim in the text shown
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
        reason: out.reason, // raw, with any grounding-check prefix; the checked claim carries the cleaned text
        definitions: defs.map((d) => `${d.section_id}:${d.term}`),
        content: (res.message.content ?? "").slice(-300),
      },
      receipt: res.receipt,
    });
    return out;
  }
  return { ...base, verdict: "struck", struck_because: "not_established", reason: "critic output unparseable", receipt };
}
