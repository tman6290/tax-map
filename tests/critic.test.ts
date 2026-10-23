import { beforeEach, describe, expect, it, vi } from "vitest";
import { criticSystemPrompt, critique } from "../src/agents/critic.js";
import type { Claim, Draft, Profile, SectionRead } from "../src/agents/types.js";
import { InMemoryWorldModel } from "../src/engines/world_model/index.js";
import { chat, type ChatOptions } from "../src/providers/meterless.js";

vi.mock("../src/providers/meterless.js", () => ({ chat: vi.fn() }));
const chatMock = vi.mocked(chat);

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
  "(1) A taxable person shall, in respect of value added tax, submit a return to the Service in the prescribed form, " +
  "on or before the 21st day of the following month. (4) The provision of subsection (1) shall not apply to a small business.";
const S147 = "Subject to the provisions of Part IX of this Chapter, VAT shall be charged on the value of all taxable supplies at the rate of 7.5%.";
const sections: Record<string, SectionRead> = {
  "NTAA-2025-s22": { heading: "Returns for value added tax", text: S22, act_id: "NTAA-2025", section_no: "22" },
  "NTA-2025-s147": { heading: "Rate of VAT", text: S147, act_id: "NTA-2025", section_no: "147" },
};
const claim = (id: string, text: string, section_ids: string[]): Claim => ({ id, text, section_ids, tier: "federal", agency: null });
const draft = (...claims: Claim[]): Draft => ({ claims, notes: [], unanswered: [] });

let n = 0;
const reply = (body: unknown) => ({
  message: { role: "assistant" as const, content: typeof body === "string" ? body : JSON.stringify(body) },
  receipt: { receipt_id: `r${++n}`, decision_id: "d", requested_model: "super", routed_model: "nvidia/nemotron-x", provider: "nvidia", label: "", tier: "A", kind: "cloud", input_tokens: 5, output_tokens: 5, latency_ms: 1, signed: true },
  raw_id: "x",
});

beforeEach(() => {
  chatMock.mockReset();
  vi.unstubAllEnvs();
});

describe("critique", () => {
  it("supports a claim whose quote is in the cited text, using the critic app and model", async () => {
    vi.stubEnv("METERLESS_CRITIC_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b");
    chatMock.mockResolvedValueOnce(
      reply({ verdict: "supported", reason: "The section sets the rate.", quote: "VAT shall be charged on the value of all taxable supplies at the rate of 7.5%", qualifier: null }),
    );

    const r = await critique(draft(claim("c1", "VAT is 7.5%.", ["NTA-2025-s147"])), sections, profile, new InMemoryWorldModel());

    expect(r.checked[0]).toMatchObject({ verdict: "supported", quote_verified: true, qualifier: null });
    const opts = chatMock.mock.calls[0]?.[0] as ChatOptions;
    expect(opts).toMatchObject({ app: "taxmap-critic", model: "nvidia/nemotron-3.5-super-vl-120b-a12b", temperature: 0 });
    expect(opts.tools).toBeUndefined();
    expect(opts.messages[1]?.content).toContain(S147);
  });

  it("keeps the qualifier on a qualified verdict, tolerating extra whitespace and ellipses around the quote", async () => {
    chatMock.mockResolvedValueOnce(
      reply({ verdict: "qualified", reason: "Small businesses are exempt.", quote: "… The provision of  subsection (1)\nshall not apply to a small business …", qualifier: "subsection (4) disapplies returns for small businesses" }),
    );
    const r = await critique(draft(claim("c3", "File a VAT return by the 21st.", ["NTAA-2025-s22"])), sections, profile, new InMemoryWorldModel());
    expect(r.checked[0]).toMatchObject({ verdict: "qualified", quote_verified: true, qualifier: "subsection (4) disapplies returns for small businesses" });
  });

  it("records a struck verdict", async () => {
    chatMock.mockResolvedValueOnce(
      reply({ verdict: "struck", reason: "Disapplied for small businesses.", quote: "shall not apply to a small business", qualifier: null }),
    );
    const r = await critique(draft(claim("c3", "File a VAT return by the 21st.", ["NTAA-2025-s22"])), sections, profile, new InMemoryWorldModel());
    expect(r.checked[0]).toMatchObject({ verdict: "struck", quote_verified: true });
  });

  it("downgrades supported to struck when the quote is not in the cited text", async () => {
    chatMock.mockResolvedValueOnce(
      reply({ verdict: "supported", reason: "Rate is set.", quote: "VAT is charged at 10 percent on every supply", qualifier: null }),
    );
    const r = await critique(draft(claim("c1", "VAT is 7.5%.", ["NTA-2025-s147"])), sections, profile, new InMemoryWorldModel());
    expect(r.checked[0]?.verdict).toBe("struck");
    expect(r.checked[0]?.quote_verified).toBe(false);
    expect(r.checked[0]?.reason).toMatch(/^quote not found in cited text: Rate is set\./);
  });

  it("strikes a negative claim against a silent section, as the prompt rule requires", async () => {
    expect(criticSystemPrompt()).toContain("cannot be supported by quoting a section that is silent on it");
    chatMock.mockResolvedValueOnce(
      reply({ verdict: "struck", reason: "The section is silent on any small-business exemption.", quote: null, qualifier: null }),
    );
    const r = await critique(
      draft(claim("c4", "There is no small-business VAT exemption.", ["NTA-2025-s147"])),
      sections,
      profile,
      new InMemoryWorldModel(),
    );
    expect(r.checked[0]).toMatchObject({ verdict: "struck", quote: null, quote_verified: false });
  });

  it("sends one correction after unparseable output, then strikes", async () => {
    chatMock.mockResolvedValueOnce(reply("I think it is supported.")).mockResolvedValueOnce(reply("Still prose."));
    const r = await critique(draft(claim("c1", "VAT is 7.5%.", ["NTA-2025-s147"])), sections, profile, new InMemoryWorldModel());
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect((chatMock.mock.calls[1]?.[0] as ChatOptions).messages.at(-1)?.content).toMatch(/No JSON object found/);
    expect(r.checked[0]).toMatchObject({ verdict: "struck", reason: "critic output unparseable" });
  });

  it("strikes a claim when the critic call fails, and goes on to the next claim", async () => {
    chatMock
      .mockRejectedValueOnce(new Error("Meterless server error: HTTP 502"))
      .mockResolvedValueOnce(reply({ verdict: "supported", reason: "ok", quote: "at the rate of 7.5%", qualifier: null }));
    const r = await critique(
      draft(claim("c1", "File a VAT return.", ["NTAA-2025-s22"]), claim("c2", "VAT is 7.5%.", ["NTA-2025-s147"])),
      sections,
      profile,
      new InMemoryWorldModel(),
    );
    expect(r.checked.map((c) => c.verdict)).toEqual(["struck", "supported"]);
    expect(r.checked[0]?.reason).toBe("critic call failed: Meterless server error: HTTP 502");
    expect(r.checked[0]?.receipt).toBeNull();
  });

  it("writes one fact per (claim, cited section) and collects every receipt", async () => {
    chatMock
      .mockResolvedValueOnce(reply({ verdict: "supported", reason: "ok", quote: "at the rate of 7.5%", qualifier: null }))
      .mockResolvedValueOnce(reply("not json"))
      .mockResolvedValueOnce(reply({ verdict: "struck", reason: "disapplied", quote: "shall not apply to a small business", qualifier: null }));
    const world = new InMemoryWorldModel();

    const r = await critique(
      draft(claim("c1", "VAT is 7.5%.", ["NTA-2025-s147"]), claim("c2", "VAT returns monthly.", ["NTAA-2025-s22", "NTA-2025-s147"])),
      sections,
      profile,
      world,
    );

    const facts = await world.getFacts();
    expect(facts.map((f) => `${f.claim_id}:${f.section_id}:${f.verdict}`)).toEqual([
      "c1:NTA-2025-s147:supported",
      "c2:NTAA-2025-s22:struck",
      "c2:NTA-2025-s147:struck",
    ]);
    expect(facts[1]).toMatchObject({ act_id: "NTAA-2025", section_no: "22", text: S22, reason: "disapplied" });
    expect(await world.getFacts({ verdict: "struck" })).toHaveLength(2);
    expect(r.receipts).toHaveLength(3);
    expect(r.checked[1]?.receipt?.receipt_id).toBe(r.receipts[2]?.receipt_id);
    expect(r.trace.filter((t) => t.kind === "model_turn")).toHaveLength(3);
  });
});
