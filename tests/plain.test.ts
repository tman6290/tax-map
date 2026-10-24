import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkPlain, cleanReason, critique, parsePlainCheck, PLAIN_CHECK_PROMPT } from "../src/agents/critic.js";
import { parseDraft } from "../src/agents/researcher.js";
import type { Claim, Profile, SectionRead, TraceStep } from "../src/agents/types.js";
import { criticDetail, describeCriticStep } from "../src/api/describe.js";
import { InMemoryWorldModel } from "../src/engines/world_model/index.js";
import { chat, type ChatOptions, type ChatRuntimeOptions, type Receipt } from "../src/providers/meterless.js";
// the drawer's text splitter is a plain ES module served to the page
import { lawBlocks } from "../public/lawtext.js";

vi.mock("../src/providers/meterless.js", () => ({ chat: vi.fn() }));
const chatMock = vi.mocked(chat);

let n = 0;
const reply = (body: unknown) => ({
  message: { role: "assistant" as const, content: typeof body === "string" ? body : JSON.stringify(body) },
  receipt: { receipt_id: `r${++n}`, decision_id: "d", requested_model: "ultra", routed_model: "nvidia/nemotron-x", provider: "nvidia", label: "", tier: "A", kind: "cloud", input_tokens: 5, output_tokens: 5, latency_ms: 1, signed: true },
  raw_id: "x",
});

const LEGAL = "The business must register with the relevant tax authority and obtain a Taxpayer Identification Number (Tax ID).";
const claim = (plain: string): Claim => ({ id: "c1", type: "obligation", text: LEGAL, plain, section_ids: ["NTAA-2025-s4"], tier: "federal", agency: null });

beforeEach(() => {
  chatMock.mockReset();
});

describe("plain-words line drafted by the Researcher", () => {
  const draftJson = (c: Record<string, unknown>) => JSON.stringify({ claims: [{ id: "c1", type: "obligation", text: LEGAL, section_ids: ["NTAA-2025-s4"], tier: "federal", agency: null, ...c }], notes: [], unanswered: [] });

  it("keeps the plain line the model drafted, with whitespace tidied", () => {
    const r = parseDraft(draftJson({ plain: "  You need to register with the tax office\n and get a Tax ID. " }));
    expect(r.ok && r.draft.claims[0]?.plain).toBe("You need to register with the tax office and get a Tax ID.");
  });

  it("falls back to an empty plain line when the model leaves it out or sends null", () => {
    for (const c of [{}, { plain: null }, { plain: "   " }]) {
      const r = parseDraft(draftJson(c));
      expect(r.ok).toBe(true);
      expect(r.ok && r.draft.claims[0]?.plain).toBe("");
    }
  });

  it("asks for the plain line in the prompt, with two examples", () => {
    const md = readFileSync(new URL("../src/agents/prompts/researcher.md", import.meta.url), "utf-8");
    expect(md).toContain('"plain": "..."');
    expect(md).toMatch(/`claims\[\]\.plain`: [^\n]*under 25 words, second person/);
    expect(md.match(/^ {2}- text: ".*" plain: "You .*"$/gm)).toHaveLength(3);
  });

  it("keeps the legal sentence in the Act's register, third person, so it differs from the plain line", () => {
    const md = readFileSync(new URL("../src/agents/prompts/researcher.md", import.meta.url), "utf-8");
    expect(md).toMatch(/`claims\[\]\.text`: the legal sentence\. [^\n]*in the Act's own register: third person, close to the section's wording/);
    expect(md).toMatch(/`claims\[\]\.text`: [^\n]*It is never second person/);
    const pairs = [...md.matchAll(/^ {2}- text: "(.*)" plain: "(.*)"$/gm)];
    for (const [, text, plain] of pairs) {
      expect(text, text).not.toMatch(/^You\b|\byou\b|\byour\b/i); // legal register: third person
      expect(plain, plain).toMatch(/^You /); // plain line: second person
      expect(plain!.split(/\s+/).length, plain).toBeLessThan(25);
      expect(plain).not.toBe(text);
    }
    // one pair is written close to the section's wording, with the Act's terms
    expect(pairs.some(([, text]) => /\bshall\b/.test(text!) && /taxable person/.test(text!) && /relevant tax authority/.test(text!))).toBe(true);
  });
});

describe("Critic check on the plain line", () => {
  const run = async (plain: string) => {
    const receipts: Receipt[] = [];
    const trace: TraceStep[] = [];
    const out = await checkPlain(claim(plain), "ultra", receipts, trace);
    return { out, receipts, trace };
  };

  it("keeps a plain line the Critic says claims nothing more, and marks it checked", async () => {
    chatMock.mockResolvedValueOnce(reply({ ok: true, fix: null }));
    const { out, receipts, trace } = await run("You need to register with the tax office and get a Tax ID.");
    expect(out).toEqual({ plain: "You need to register with the tax office and get a Tax ID.", checked: true });
    expect(receipts).toHaveLength(1);
    expect(trace[0]?.detail).toMatchObject({ phase: "plain_check", claim_id: "c1", ok: true });
  });

  it("sends the plain and legal sentences in one call, no tools, 60 s, no retries", async () => {
    chatMock.mockResolvedValueOnce(reply({ ok: true, fix: null }));
    await run("You need to get a Tax ID.");
    expect(chatMock).toHaveBeenCalledTimes(1);
    const [opts, runtime] = chatMock.mock.calls[0] as [ChatOptions, ChatRuntimeOptions];
    expect(opts.tools).toBeUndefined();
    expect(opts).toMatchObject({ app: "taxmap-critic", model: "ultra", temperature: 0 });
    expect(runtime).toEqual({ timeoutMs: 60_000, retries: 0 });
    expect(opts.messages[0]?.content).toBe(PLAIN_CHECK_PROMPT);
    expect(PLAIN_CHECK_PROMPT).toContain("Does the plain sentence claim anything the legal sentence does not?");
    expect(PLAIN_CHECK_PROMPT).toContain('{"ok": boolean, "fix": string|null}');
    expect(opts.messages[1]?.content).toBe(`Legal sentence: ${LEGAL}\nPlain sentence: You need to get a Tax ID.`);
  });

  it("replaces a plain line that claims more with the Critic's fix", async () => {
    chatMock.mockResolvedValueOnce(reply(`<think>adds a deadline</think>{"ok": false, "fix": "You need to register with the tax office and get a Tax ID."}`));
    const { out, trace } = await run("You need to get a Tax ID within 30 days or pay a fine.");
    expect(out).toEqual({ plain: "You need to register with the tax office and get a Tax ID.", checked: true });
    expect(trace[0]?.detail).toMatchObject({ ok: false, original: "You need to get a Tax ID within 30 days or pay a fine." });
    expect(criticDetail(trace[0]!)).toMatch(/^Critic plain-words check for claim c1: replaced "/);
    expect(describeCriticStep(trace[0]!)).toBe(""); // silent in the progress panel
  });

  it("drops the plain line when the Critic finds a problem but gives no fix", async () => {
    chatMock.mockResolvedValueOnce(reply({ ok: false, fix: null }));
    expect((await run("You must pay VAT.")).out).toEqual({ plain: "", checked: false });
  });

  it("leaves the line unchecked when the call fails or the reply cannot be read", async () => {
    chatMock.mockRejectedValueOnce(new Error("Meterless HTTP 502"));
    expect((await run("You need to get a Tax ID.")).out).toEqual({ plain: "You need to get a Tax ID.", checked: false });
    chatMock.mockResolvedValueOnce(reply("I think it is fine."));
    expect((await run("You need to get a Tax ID.")).out).toEqual({ plain: "You need to get a Tax ID.", checked: false });
  });

  it("makes no call when there is no plain line", async () => {
    expect((await run("")).out).toEqual({ plain: "", checked: false });
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("parses {ok, fix} replies", () => {
    expect(parsePlainCheck('```json\n{"ok": true}\n```')).toEqual({ ok: true, value: { ok: true, fix: "" } });
    expect(parsePlainCheck('{"ok": "yes"}').ok).toBe(false);
    // the replies seen live: the object, then more text or a second object
    expect(parsePlainCheck('{"ok": true, "fix": null}\n\nThe plain sentence says nothing more. {"note": 1}')).toEqual({ ok: true, value: { ok: true, fix: "" } });
    expect(parsePlainCheck('{"ok": false, "fix": "You need a Tax ID {now}."}\n{"ok": true}')).toEqual({ ok: true, value: { ok: false, fix: "You need a Tax ID {now}." } });
    expect(parsePlainCheck('{"verdict": "x"} {"ok": true, "fix": null}')).toEqual({ ok: true, value: { ok: true, fix: "" } });
  });

  it("records plain_checked on every checked claim, after the verdict", async () => {
    const S4 = "Every taxable person shall register with the relevant tax authority and obtain a Taxpayer Identification Number.";
    const sections: Record<string, SectionRead> = { "NTAA-2025-s4": { heading: "Registration", text: S4, act_id: "NTAA-2025", section_no: "4" } };
    const profile: Profile = { business_type: "sole_proprietor", sector: "retail", state: "Lagos", lga: "Ikeja", turnover_band: "under_25m", fixed_assets_band: "under_250m", employees: 3, has_premises: true, has_signage: true };
    chatMock
      .mockResolvedValueOnce(reply({ verdict: "supported", reason: "s. 4 requires it.", quote: "Every taxable person shall register with the relevant tax authority", qualifier: null }))
      .mockResolvedValueOnce(reply({ ok: true, fix: null }));
    const r = await critique({ claims: [claim("You need to register and get a Tax ID.")], notes: [], unanswered: [] }, sections, profile, new InMemoryWorldModel());
    expect(r.checked[0]).toMatchObject({ verdict: "supported", plain_checked: true, claim: { plain: "You need to register and get a Tax ID." } });
    expect(r.receipts).toHaveLength(2);
    expect((chatMock.mock.calls[1]?.[0] as ChatOptions).messages[0]?.content).toBe(PLAIN_CHECK_PROMPT); // the verdict call came first
  });
});

describe("drawer: section text as paragraphs and nested lists", () => {
  it("lists (a), (b) items that start a clause, nests (i), (ii) under them, and keeps cross-references inline", () => {
    const text = "(1) A person shall — (a) keep books; (b) file returns that — (i) state income; and (ii) state tax; and (c) pay. (2) See subsection (1) of this section.";
    expect(lawBlocks(text)).toEqual([
      { level: 0, text: "(1) A person shall —" },
      { level: 1, text: "(a) keep books;" },
      { level: 1, text: "(b) file returns that —" },
      { level: 2, text: "(i) state income; and" },
      { level: 2, text: "(ii) state tax; and" },
      { level: 1, text: "(c) pay." },
      { level: 0, text: "(2) See subsection (1) of this section." },
    ]);
  });

  it("treats (i) after (h) as a letter, and a list that starts at (i) as roman numerals at the first level", () => {
    const letters = "Any of — (g) one; (h) two; (i) three; (j) four.";
    expect(lawBlocks(letters).map((b) => b.level)).toEqual([0, 1, 1, 1, 1]);
    const roman = "Where — (i) one; (ii) two; or (iii) three.";
    expect(lawBlocks(roman).map((b) => b.level)).toEqual([0, 1, 1, 1]);
  });

  it("keeps text with no markers as one paragraph, and starts each definition on its own", () => {
    expect(lawBlocks("Every taxable person shall register.")).toEqual([{ level: 0, text: "Every taxable person shall register." }]);
    const defs = lawBlocks('In this Act — "bank" means a bank ; "business" includes a trade —');
    expect(defs.map((b) => b.text)).toEqual(["In this Act —", '"bank" means a bank ;', '"business" includes a trade —']);
  });
});

describe("Why text cleaned at the source", () => {
  it("strips grounding-check prefixes", () => {
    expect(cleanReason("text does not establish the claim: The quoted text imposes a filing duty.")).toBe("The quoted text imposes a filing duty.");
    expect(cleanReason("quote not found in cited text: rate is set by s. 147.")).toBe("Rate is set by s. 147.");
    expect(cleanReason("quote not found in cited text: text does not establish the claim: x.")).toBe("X.");
    expect(cleanReason("critic call failed: HTTP 502")).toBe("critic call failed: HTTP 502"); // no prefix, unchanged
  });

  it("writes profile band tokens as words, absorbing the field name and bracketed figure", () => {
    expect(
      cleanReason(
        "The shop's turnover band under_25m (≤ N25m) and fixed assets under_250m (< N250m) meet the definition of a small business.",
      ),
    ).toBe("The shop's turnover under ₦25 million and fixed assets under ₦250 million meet the definition of a small business.");
    expect(cleanReason("With turnover_band 25m_to_100m the rule applies.")).toBe("With turnover between ₦25 million and ₦100 million the rule applies.");
    expect(cleanReason("Bands over_100m and over_250m.")).toBe("Bands turnover over ₦100 million and fixed assets over ₦250 million.");
    expect(cleanReason("fixed_assets_band: under_250m")).toBe("fixed assets under ₦250 million");
  });
});
