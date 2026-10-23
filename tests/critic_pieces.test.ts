import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { critique, mergePieces, packPieces, relevantDefinitions, splitSubsections, type PieceResult } from "../src/agents/critic.js";
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

  it("picks the definitions for terms in the claim or piece", () => {
    const d = relevantDefinitions(DEFS, "A taxable person shall file; not for a small business");
    expect(d).toContain('"small business" means');
    expect(d).toContain('"taxable person" means');
    expect(d).not.toContain("trustee");
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

  it("prefers qualified, then verified support, then strikes with 'no piece supports the claim'", () => {
    expect(mergePieces([piece({}), piece({ verdict: "qualified", qualifier: "threshold", struck_because: null })]).verdict).toBe("qualified");
    expect(mergePieces([piece({}), piece({ verdict: "supported", quote_verified: true, struck_because: null })]).verdict).toBe("supported");
    expect(mergePieces([piece({}), piece({})])).toMatchObject({ verdict: "struck", reason: "no piece supports the claim" });
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

  it("judges each piece with the definitions labelled ahead of the operative text, and the disapplying piece decides", async () => {
    vi.stubEnv("CRITIC_PIECE_CHARS", "200");
    chatMock
      .mockResolvedValueOnce(reply({ verdict: "supported", reason: "files by the 21st", quote: "submit a return on or before the 21st day", qualifier: null }))
      .mockResolvedValue(reply({ verdict: "struck", reason: "small businesses are exempt", quote: "shall not apply to a small business", qualifier: null, struck_because: "disapplies" }));

    const r = await critique(draft, sections, profile, new InMemoryWorldModel());

    const calls = chatMock.mock.calls.map((c) => (c[0] as ChatOptions).messages[1]?.content ?? "");
    expect(calls.length).toBeGreaterThan(1); // the definitions section is context, not a judged piece
    for (const msg of calls) {
      expect(msg.indexOf("Definitions (cited")).toBeGreaterThan(-1);
      expect(msg.indexOf("Definitions (cited")).toBeLessThan(msg.indexOf("Operative text:"));
      expect(msg).toMatch(/piece \d of \d/);
    }
    expect(r.checked[0]).toMatchObject({ verdict: "struck", quote: "shall not apply to a small business", quote_verified: true });
    const pieces = r.trace.filter((t) => (t.detail as { piece?: string }).piece);
    expect(pieces.length).toBe(calls.length);
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
