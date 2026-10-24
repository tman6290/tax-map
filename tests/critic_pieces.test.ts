import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { criticSystemPrompt, critique, mergePieces, packPieces, quoteInTexts, splitSubsections, type PieceResult } from "../src/agents/critic.js";
import type { Profile, SectionRead } from "../src/agents/types.js";
import { InMemoryWorldModel } from "../src/engines/world_model/index.js";
import { chat, type ChatOptions } from "../src/providers/meterless.js";
import { nvidiaChat } from "../src/providers/nvidia.js";

vi.mock("../src/providers/meterless.js", () => ({ chat: vi.fn() }));
vi.mock("../src/providers/nvidia.js", () => ({ nvidiaChat: vi.fn() }));
const chatMock = vi.mocked(chat);
const nvidiaMock = vi.mocked(nvidiaChat);

const profile: Profile = {
  business_type: "sole_proprietor",
  sector: "retail",
  state: "Lagos",
  lga: "Ikeja",
  turnover_band: "under_25m",
  fixed_assets_band: "under_250m",
  employees: 3,
  has_premises: true,
  has_signage: true,
};
const S22 =
  "(1) A taxable person shall submit a return on or before the 21st day of the following month. " +
  "(2) Where the Service grants an extension under subsection (1), it shall not extend the time to pay. " +
  "(3) The returns shall contain the input tax paid. " +
  "(4) The provision of subsection (1) shall not apply to a small business.";
const DEFS =
  '"small business" means a business with turnover of N100,000,000 or less; "taxable person" means a person liable to tax; ' +
  '"trustee" means a person holding property in trust;';
const reply = (body: unknown) => ({
  message: { role: "assistant" as const, content: JSON.stringify(body) },
  receipt: { receipt_id: "r", decision_id: "d", requested_model: "m", routed_model: "m", provider: "p", label: "", tier: "", kind: "", input_tokens: 1, output_tokens: 1, latency_ms: 1, signed: true },
  raw_id: "x",
});
const piece = (over: Partial<PieceResult>): PieceResult => ({
  label: "s 1/2",
  verdict: "struck",
  struck_because: "silent",
  reason: "silent",
  quote: null,
  quote_verified: false,
  qualifier: null,
  receipt: null,
  ...over,
});

beforeEach(() => {
  chatMock.mockReset();
  nvidiaMock.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("chunking", () => {
  it("splits at subsection markers in sequence, ignoring cross-references", () => {
    const subs = splitSubsections(S22);
    expect(subs).toHaveLength(4);
    expect(subs[1]).toMatch(/^\(2\) Where the Service grants an extension under subsection \(1\)/);
    expect(splitSubsections("No subsections here.")).toEqual(["No subsections here."]);
  });

  it("packs subsections into pieces no longer than the limit", () => {
    const pieces = packPieces(splitSubsections(S22), 200);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 200)).toBe(true);
    expect(pieces.join(" ")).toBe(splitSubsections(S22).join(" "));
  });
});

describe("quote grounding", () => {
  it("ignores quotation marks round defined terms but nothing else", () => {
    const def = '"small business" means a business that earns gross turnover of N50,000,000 or less per annum';
    expect(quoteInTexts("small business means a business that earns gross turnover of N50,000,000 or less", [def])).toBe(true);
    expect(quoteInTexts("small business means a business earning gross turnover of N50,000,000 or less", [def])).toBe(false);
  });

  it("accepts 2-4 verbatim fragments joined by ' … ' in document order", () => {
    expect(
      quoteInTexts("A taxable person shall submit a return on or before the 21st day … The provision of subsection (1) shall not apply to a small business", [S22]),
    ).toBe(true);
  });

  it("rejects fragments out of order, too short, too many, from different sections, or joined with '...'", () => {
    const other = "VAT shall be charged on the value of all taxable supplies at the rate of 7.5%.";
    expect(quoteInTexts("The provision of subsection (1) shall not apply to a small business … A taxable person shall submit a return", [S22])).toBe(false);
    expect(quoteInTexts("A taxable person shall submit a return on or before the 21st day … a small business", [S22])).toBe(false); // second fragment under 20 chars
    expect(quoteInTexts("A taxable person shall submit a return … at the rate of 7.5% on all", [S22, other])).toBe(false); // spans two texts
    expect(quoteInTexts("A taxable person shall submit a return on or before ... shall not apply to a small business", [S22])).toBe(false);
    const five = ["(1) A taxable person shall submit", "21st day of the following month.", "Where the Service grants an extension", "The returns shall contain the input", "shall not apply to a small business"];
    expect(quoteInTexts(five.join(" … "), [S22])).toBe(false);
  });

  it("supports a correctly stated exemption and tells the Critic the claim type", async () => {
    chatMock.mockResolvedValueOnce(
      reply({ verdict: "supported", reason: "small business, subsection (4) disapplies (1)", quote: "The provision of subsection (1) shall not apply to a small business", qualifier: null, struck_because: null }),
    );
    const sections: Record<string, SectionRead> = { "NTAA-2025-s22": { heading: "Returns", text: S22, act_id: "NTAA-2025", section_no: "22" } };
    const r = await critique(
      { claims: [{ id: "e1", type: "exemption", text: "As a small business the shop does not have to file VAT returns.", section_ids: ["NTAA-2025-s22"], tier: "federal", agency: null }], notes: [], unanswered: [] },
      sections,
      profile,
      new InMemoryWorldModel(),
    );
    const msg = (chatMock.mock.calls[0]?.[0] as ChatOptions).messages[1]?.content ?? "";
    expect(msg).toContain("Claim type: exemption");
    expect(r.checked[0]).toMatchObject({ verdict: "supported", quote_verified: true });
    expect(criticSystemPrompt()).toContain('A correctly stated exemption is "supported", not "struck".');
    expect(criticSystemPrompt()).toContain("Naming the administering body differently is not grounds to strike.");
  });

  it("puts both profile bands, with their meanings, in the Critic message", async () => {
    chatMock.mockResolvedValueOnce(reply({ verdict: "struck", reason: "x", quote: null, qualifier: null, struck_because: "not_established" }));
    const sections: Record<string, SectionRead> = { "NTAA-2025-s22": { heading: "Returns", text: S22, act_id: "NTAA-2025", section_no: "22" } };
    await critique({ claims: [{ id: "c", text: "File returns.", section_ids: ["NTAA-2025-s22"], tier: "federal", agency: null }], notes: [], unanswered: [] }, sections, profile, new InMemoryWorldModel());
    const msg = (chatMock.mock.calls[0]?.[0] as ChatOptions).messages[1]?.content ?? "";
    expect(msg).toContain('"fixed_assets_band": "under_250m"');
    expect(msg).toContain("under_250m: under N250,000,000");
  });

  it("rejects quotes that join separate subsections", () => {
    expect(quoteInTexts("submit a return on or before the 21st day of the following month. The provision of subsection (1) shall not apply", [S22])).toBe(false);
  });
});

describe("mergePieces", () => {
  it("lets a disapplying strike win over support", () => {
    const m = mergePieces([
      piece({ label: "a 1/2", verdict: "supported", struck_because: null, quote: "q", quote_verified: true, reason: "supports" }),
      piece({ label: "a 2/2", verdict: "struck", struck_because: "disapplies", quote: "shall not apply", quote_verified: true, reason: "exempt" }),
    ]);
    expect(m).toMatchObject({ verdict: "struck", quote: "shall not apply", quote_verified: true, reason: "[a 2/2] exempt" });
  });

  it("prefers qualified, then verified support, then strikes with a plain reason", () => {
    expect(mergePieces([piece({}), piece({ verdict: "qualified", qualifier: "threshold", struck_because: null })]).verdict).toBe("qualified");
    expect(mergePieces([piece({}), piece({ verdict: "supported", quote_verified: true, struck_because: null })]).verdict).toBe("supported");
    expect(mergePieces([piece({}), piece({})])).toMatchObject({ verdict: "struck", reason: "None of the cited sections, read in full, supports this line." });
  });

  it("applies the no-silent rule: a verified disapplying quote decides even when labelled not_established", () => {
    const m = mergePieces([
      piece({ label: "a 1/2", verdict: "supported", struck_because: null, quote: "submit a return", quote_verified: true, reason: "files" }),
      piece({
        label: "a 2/2",
        verdict: "struck",
        struck_because: "not_established",
        quote: "The provision of subsection (1) shall not apply to a small business.",
        quote_verified: true,
        reason: "text does not establish the claim: terms undefined",
      }),
    ]);
    expect(m).toMatchObject({ verdict: "struck", quote: "The provision of subsection (1) shall not apply to a small business." });
    // without a verified quote, a not_established strike does not decide
    expect(mergePieces([piece({ verdict: "supported", quote_verified: true, struck_because: null }), piece({ struck_because: "not_established", quote: "shall not apply", quote_verified: false })]).verdict).toBe("supported");
  });

  it("does not treat a disapplying quote as decisive against an exemption claim", () => {
    const pieces = [
      piece({ label: "s 1/2", verdict: "struck", struck_because: "not_established", quote: "shall not apply to a small business", quote_verified: true, reason: "duty part only" }),
      piece({ label: "s 2/2", verdict: "supported", struck_because: null, quote: "The provision of subsection (1) shall not apply to a small business", quote_verified: true, reason: "exempt" }),
    ];
    expect(mergePieces(pieces, "exemption").verdict).toBe("supported");
    expect(mergePieces(pieces, "obligation").verdict).toBe("struck");
  });

  it("is unchecked when a piece failed and nothing decisive was found", () => {
    const m = mergePieces([piece({ verdict: "supported", quote_verified: true, struck_because: null }), piece({ label: "s 2/2", verdict: "unchecked", struck_because: null })]);
    expect(m).toMatchObject({ verdict: "unchecked", reason: "1 of 2 pieces could not be checked: s 2/2" });
  });
});

describe("critique with pieces and definitions", () => {
  const sections: Record<string, SectionRead> = {
    "NTAA-2025-s22": { heading: "Returns for value added tax", text: S22, act_id: "NTAA-2025", section_no: "22" },
    "NTAA-2025-s147": { heading: "Interpretation", text: DEFS, act_id: "NTAA-2025", section_no: "147" },
  };
  const draft = {
    claims: [{ id: "c3", text: "The shop must file a VAT return by the 21st.", section_ids: ["NTAA-2025-s147", "NTAA-2025-s22"], tier: "federal" as const, agency: null }],
    notes: [],
    unanswered: [],
  };

  it("judges each piece with glossary definitions labelled ahead of the operative text, and the disapplying piece decides", async () => {
    vi.stubEnv("CRITIC_PIECE_CHARS", "200");
    chatMock
      .mockResolvedValueOnce(reply({ verdict: "supported", reason: "files by the 21st", quote: "submit a return on or before the 21st day", qualifier: null }))
      .mockResolvedValue(reply({ verdict: "struck", reason: "small businesses are exempt", quote: "shall not apply to a small business", qualifier: null, struck_because: "disapplies" }));

    const r = await critique(draft, sections, profile, new InMemoryWorldModel());

    const calls = chatMock.mock.calls.map((c) => (c[0] as ChatOptions).messages[1]?.content ?? "");
    expect(calls.length).toBeGreaterThan(1); // the cited interpretation section is context, not a judged piece
    for (const msg of calls) {
      const defsAt = msg.indexOf("Definitions (authoritative for the terms they define):");
      expect(defsAt).toBeGreaterThan(-1);
      expect(defsAt).toBeLessThan(msg.indexOf("Operative text:"));
      expect(msg).toContain('--- NTAA-2025-s147 "small business"'); // labelled with its section_id
      expect(msg).toMatch(/piece \d of \d/);
    }
    expect(r.checked[0]).toMatchObject({ verdict: "struck", quote: "shall not apply to a small business", quote_verified: true });
    expect(r.checked[0]?.definitions_used).toContain("NTAA-2025-s147");
    const pieces = r.trace.filter((t) => (t.detail as { piece?: string }).piece);
    expect(pieces.length).toBe(calls.length);
  });

  it("judges a section whole by default and re-chunks it after an HTTP 502", async () => {
    const long = Array.from({ length: 4 }, (_, i) => `(${i + 1}) A taxable person shall comply with rule ${i + 1}. ${"Text continues here. ".repeat(18)}`).join(" ");
    const longSections: Record<string, SectionRead> = {
      "NTAA-2025-s22": { heading: "Returns for value added tax", text: long, act_id: "NTAA-2025", section_no: "22" },
    };
    chatMock
      .mockRejectedValueOnce(new Error("Meterless server error: HTTP 502"))
      .mockResolvedValue(reply({ verdict: "supported", reason: "rule", quote: "A taxable person shall comply with rule", qualifier: null }));

    const r = await critique({ ...draft, claims: [{ ...draft.claims[0]!, section_ids: ["NTAA-2025-s22"] }] }, longSections, profile, new InMemoryWorldModel());

    const first = (chatMock.mock.calls[0]?.[0] as ChatOptions).messages[1]?.content ?? "";
    expect(first).not.toMatch(/piece \d of \d/); // whole section at the 6,000-character default
    expect(chatMock.mock.calls.length).toBeGreaterThan(2); // then smaller pieces
    expect(r.checked[0]?.verdict).toBe("supported");
  });
});

describe("provider fallback", () => {
  const sections: Record<string, SectionRead> = {
    "NTA-2025-s147": { heading: "Rate of VAT", text: "VAT shall be charged at the rate of 7.5%.", act_id: "NTA-2025", section_no: "147" },
  };
  const draft = { claims: [{ id: "c1", text: "VAT is 7.5%.", section_ids: ["NTA-2025-s147"], tier: "federal" as const, agency: null }], notes: [], unanswered: [] };

  it("does not use nvidia-direct unless CRITIC_DIRECT_NVIDIA=true and a key is set", async () => {
    chatMock.mockRejectedValue(new Error("Meterless server error: HTTP 502"));
    const r = await critique(draft, sections, profile, new InMemoryWorldModel());
    expect(nvidiaMock).not.toHaveBeenCalled();
    expect(r.checked[0]?.verdict).toBe("unchecked");
  });

  it("falls back to nvidia-direct with a warning when enabled", async () => {
    vi.stubEnv("CRITIC_DIRECT_NVIDIA", "true");
    vi.stubEnv("NVIDIA_API_KEY", "nv-test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    chatMock.mockRejectedValue(new Error("Meterless server error: HTTP 502"));
    nvidiaMock.mockResolvedValue(reply({ verdict: "supported", reason: "rate", quote: "at the rate of 7.5%", qualifier: null }));

    const r = await critique(draft, sections, profile, new InMemoryWorldModel());

    expect(nvidiaMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nvidia-direct"));
    expect(r.checked[0]?.verdict).toBe("supported");
    warn.mockRestore();
  });
});
