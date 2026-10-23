import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { WorldModel } from "../engines/types.js";
import { chat, type ChatMessage, type Receipt } from "../providers/meterless.js";
import type { CheckedClaim, Claim, CritiqueResult, Draft, Profile, SectionRead, TraceStep, Verdict } from "./types.js";

export const CRITIC_APP = "taxmap-critic";
const DEFAULT_CRITIC_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
const SECTION_TEXT_CHARS = 8_000;
const QUOTE_NOT_FOUND = "quote not found in cited text: ";

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

const VerdictSchema = z.object({
  verdict: z.enum(["supported", "qualified", "struck"]),
  reason: z.string().min(1),
  quote: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v : null)),
  qualifier: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v : null)),
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

/** True when the quote (minus any leading/trailing ellipsis or quote marks) occurs in one cited text. */
export function quoteInTexts(quote: string | null, texts: string[]): boolean {
  if (!quote) return false;
  const q = normaliseForQuote(quote)
    .replace(/^["'\s]*(?:\.\.\.|…)?\s*/, "")
    .replace(/\s*(?:\.\.\.|…)?["'\s]*$/, "");
  if (q.length < 8) return false; // too short to ground anything
  return texts.some((t) => normaliseForQuote(t).includes(q));
}

function userMessage(profile: Profile, claim: Claim, cited: Array<{ id: string; section: SectionRead }>): string {
  const parts = [
    "Business profile (turnover bands are annual turnover in naira):",
    JSON.stringify(profile, null, 2),
    "",
    `Claim: ${claim.text}`,
    "",
    "Quoted statute text of every section the claim cites:",
  ];
  for (const { id, section } of cited) {
    const text =
      section.text.length > SECTION_TEXT_CHARS ? `${section.text.slice(0, SECTION_TEXT_CHARS)} [truncated]` : section.text;
    parts.push("", `--- ${id}${section.heading ? `: ${section.heading}` : ""}`, text);
  }
  return parts.join("\n");
}

const now = () => new Date().toISOString();

/**
 * Judge every drafted claim against the verbatim text of the sections it cites. One model call
 * per claim (plus at most one correction). The Critic never adds claims, it only judges them.
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
      result = await judge(claim, cited, profile, model, receipts, trace);
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

async function judge(
  claim: Claim,
  cited: Array<{ id: string; section: SectionRead }>,
  profile: Profile,
  model: string,
  receipts: Receipt[],
  trace: TraceStep[],
): Promise<Omit<CheckedClaim, "claim">> {
  const messages: ChatMessage[] = [
    { role: "system", content: criticSystemPrompt() },
    { role: "user", content: userMessage(profile, claim, cited) },
  ];
  let receipt: Receipt | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Awaited<ReturnType<typeof chat>>;
    try {
      res = await chat({ messages, app: CRITIC_APP, model, temperature: 0 });
    } catch (err) {
      // chat() has already retried; an unjudged claim is not shown as established
      const msg = err instanceof Error ? err.message : String(err);
      trace.push({ kind: "model_turn", ts: now(), detail: { claim_id: claim.id, attempt, error: msg } });
      return { verdict: "struck", reason: `critic call failed: ${msg}`, quote: null, quote_verified: false, qualifier: null, receipt };
    }
    receipt = res.receipt;
    receipts.push(res.receipt);
    trace.push({
      kind: "model_turn",
      ts: now(),
      detail: { claim_id: claim.id, attempt, content: (res.message.content ?? "").slice(0, 300) },
      receipt: res.receipt,
    });

    const parsed = parseVerdict(res.message.content);
    if (parsed.ok) {
      const v = parsed.value;
      const verified = quoteInTexts(v.quote, cited.map((c) => c.section.text));
      let verdict: Verdict = v.verdict;
      let reason = v.reason;
      if ((verdict === "supported" || verdict === "qualified") && !verified) {
        verdict = "struck";
        reason = `${QUOTE_NOT_FOUND}${reason}`;
      }
      return {
        verdict,
        reason,
        quote: v.quote,
        quote_verified: verified,
        qualifier: verdict === "qualified" ? v.qualifier : null,
        receipt,
      };
    }
    messages.push(
      { role: "assistant", content: res.message.content ?? "" },
      {
        role: "user",
        content: `${parsed.error} Reply again with only one JSON object of the form {"verdict": "...", "reason": "...", "quote": "...", "qualifier": null} and no other text.`,
      },
    );
  }
  return { verdict: "struck", reason: "critic output unparseable", quote: null, quote_verified: false, qualifier: null, receipt };
}
