import { beforeEach, describe, expect, it, vi } from "vitest";
import { CRITIC_CONCURRENCY, critique } from "../src/agents/critic.js";
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
  fixed_assets_band: "under_250m",
  employees: 3,
  has_premises: true,
  has_signage: true,
};

const TEXT = "A taxable person shall keep books of account for the business and shall retain them for six years.";
const sections: Record<string, SectionRead> = Object.fromEntries(
  Array.from({ length: 8 }, (_, i) => [`NTAA-2025-s${i + 1}`, { heading: `Heading ${i + 1}`, text: `${TEXT} (${i + 1})`, act_id: "NTAA-2025", section_no: String(i + 1) }]),
);
const claim = (n: number, plain = ""): Claim => ({ id: `c${n}`, type: "obligation", text: `Claim ${n}: the business must keep books of account.`, plain, section_ids: [`NTAA-2025-s${n}`], tier: "federal", agency: null });
const draft = (...claims: Claim[]): Draft => ({ claims, notes: [], unanswered: [] });

const receiptFor = (label: string) => ({
  receipt_id: `rcpt-${label}`,
  decision_id: "d",
  requested_model: "m",
  routed_model: "nvidia/nemotron-x",
  provider: "nvidia",
  label,
  tier: "C",
  kind: "cloud",
  input_tokens: 1,
  output_tokens: 1,
  latency_ms: 1,
  signed: true,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Which claim and which kind of call a mocked chat call is, from its messages. */
function callOf(opts: ChatOptions): { n: number; kind: "verdict" | "plain" } {
  const user = String(opts.messages[1]?.content);
  const n = Number(/Claim (\d+):/.exec(user)?.[1] ?? /Legal sentence: Claim (\d+):/.exec(user)?.[1]);
  return { n, kind: opts.messages[0]?.content?.startsWith("You compare two sentences") ? "plain" : "verdict" };
}

interface Timeline {
  events: string[];
  inFlight: number;
  maxInFlight: number;
}
/** A chat mock that answers after `delay(n, kind)` ms, and keeps a count of calls in flight. */
function mockChat(delay: (n: number, kind: "verdict" | "plain") => number): Timeline {
  const t: Timeline = { events: [], inFlight: 0, maxInFlight: 0 };
  chatMock.mockImplementation(async (opts: ChatOptions) => {
    const { n, kind } = callOf(opts);
    t.inFlight++;
    t.maxInFlight = Math.max(t.maxInFlight, t.inFlight);
    t.events.push(`start ${kind} ${n}`);
    await sleep(delay(n, kind));
    t.inFlight--;
    t.events.push(`end ${kind} ${n}`);
    const body =
      kind === "plain"
        ? { ok: true, fix: null }
        : { verdict: "supported", reason: `Claim ${n} is supported.`, quote: "shall keep books of account for the business", qualifier: null, struck_because: null };
    return { message: { role: "assistant" as const, content: JSON.stringify(body) }, receipt: receiptFor(`${kind}-c${n}`), raw_id: "x" };
  });
  return t;
}

beforeEach(() => {
  chatMock.mockReset(); // braces: a function returned from beforeEach would run as a cleanup hook
});

describe("critique concurrency", () => {
  it("has four claims in flight at once, and never a fifth verdict", async () => {
    expect(CRITIC_CONCURRENCY).toBe(4);
    const t = mockChat(() => 40);
    const r = await critique(draft(...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => claim(n))), sections, profile, new InMemoryWorldModel());
    expect(t.maxInFlight).toBe(4);
    // the first four verdicts start before any ends
    expect(t.events.slice(0, 4)).toEqual(["start verdict 1", "start verdict 2", "start verdict 3", "start verdict 4"]);
    expect(r.checked).toHaveLength(8);
    expect(chatMock).toHaveBeenCalledTimes(8);
  });

  it("returns results, receipts and trace in claim order even when later claims finish first", async () => {
    // claim 1 is the slowest and claim 4 the quickest, so completion order is the reverse of claim order
    mockChat((n) => (n <= 4 ? (5 - n) * 30 : 10));
    const seen: string[] = [];
    const streamed: string[] = [];
    const r = await critique(
      draft(...[1, 2, 3, 4, 5, 6].map((n) => claim(n, `You must keep books ${n}.`))),
      sections,
      profile,
      new InMemoryWorldModel(),
      { onChecked: (c) => seen.push(c.claim.id), onTrace: (s) => streamed.push(String((s.detail as { claim_id?: string }).claim_id)) },
    );
    expect(r.checked.map((c) => c.claim.id)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(seen).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]); // verdict events follow the draft order
    // within a claim: its verdict receipt, then its plain-words receipt; across claims: claim order
    expect(r.receipts.map((x) => x.label)).toEqual([1, 2, 3, 4, 5, 6].flatMap((n) => [`verdict-c${n}`, `plain-c${n}`]));
    const traced = r.trace.map((s) => String((s.detail as { claim_id?: string }).claim_id));
    expect(traced).toEqual([1, 2, 3, 4, 5, 6].flatMap((n) => [`c${n}`, `c${n}`]));
    expect(streamed.sort()).toEqual([...traced].sort()); // the live stream carries the same steps
    expect(r.checked.every((c) => c.plain_checked)).toBe(true);
  });

  it("starts the next claim's verdict while an earlier claim's plain-words check is still running", async () => {
    // five claims: claim 1's plain check is slow; claim 5 must not wait for it
    const t = mockChat((n, kind) => (kind === "plain" && n === 1 ? 200 : 20));
    await critique(draft(...[1, 2, 3, 4, 5].map((n) => claim(n, `You must keep books ${n}.`))), sections, profile, new InMemoryWorldModel());
    const at = (e: string) => t.events.indexOf(e);
    expect(at("start verdict 5")).toBeGreaterThan(-1);
    expect(at("start plain 1")).toBeGreaterThan(-1);
    expect(at("start verdict 5")).toBeLessThan(at("end plain 1"));
    // and the plain check of claim 1 starts when its verdict is in, not after the other claims
    expect(at("start plain 1")).toBe(at("end verdict 1") + 1);
  });

  it("keeps each call's own timeout and one claim's failure to its own claim", async () => {
    chatMock.mockImplementation(async (opts: ChatOptions) => {
      const { n, kind } = callOf(opts);
      if (kind === "verdict" && n === 2) throw new Error("Meterless request timed out after 150000 ms");
      const body = kind === "plain" ? { ok: true, fix: null } : { verdict: "supported", reason: "ok", quote: "shall keep books of account for the business", qualifier: null, struck_because: null };
      return { message: { role: "assistant" as const, content: JSON.stringify(body) }, receipt: receiptFor(`${kind}-c${n}`), raw_id: "x" };
    });
    const r = await critique(draft(claim(1), claim(2), claim(3)), sections, profile, new InMemoryWorldModel());
    expect(r.checked.map((c) => [c.claim.id, c.verdict])).toEqual([["c1", "supported"], ["c2", "unchecked"], ["c3", "supported"]]);
    // verdict calls keep the 150 s limit and plain-words checks the 60 s limit
    for (const [opts, runtime] of chatMock.mock.calls as Array<[ChatOptions, { timeoutMs?: number; retries?: number }]>) {
      expect(runtime.timeoutMs).toBe(callOf(opts).kind === "plain" ? 60_000 : 150_000);
    }
  });
});
