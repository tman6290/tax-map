import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../src/providers/meterless.js";

const TOKEN = "sekret-token-123";
const FAST = { backoffMs: 1 };
let dir: string;
let logFile: string;

const completion = (message: Record<string, unknown>, withEnvelope = true) => ({
  id: "chatcmpl-1",
  model: "nvidia/nemotron-routed",
  choices: [{ index: 0, message: { role: "assistant", ...message } }],
  meterless: {
    receipt_id: "rcpt_1",
    decision_id: "dec_1",
    requested_model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    routed_model: "nvidia/nemotron-routed",
    winning_route: { model: "nvidia/nemotron-routed", label: "fast", provider: "nvidia", kind: "hosted", tier: "T1" },
    usage: { input_tokens: 12, output_tokens: 3, latency_ms: 250 },
    ...(withEnvelope ? { receipt_envelope: { pubkey_b64: "cHVi", sig_b64: "c2ln" } } : {}),
  },
});
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meterless-"));
  logFile = join(dir, "logs", "model_calls.jsonl");
  vi.stubEnv("METERLESS_BASE_URL", "http://nightshift.test/v1");
  vi.stubEnv("METERLESS_RUNTIME_TOKEN", TOKEN);
  vi.stubEnv("METERLESS_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b");
  vi.stubEnv("METERLESS_APP", "taxmap");
  vi.stubEnv("METERLESS_LOG_FILE", logFile);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("chat", () => {
  it("parses the receipt, sends the meterless headers and defaults temperature to 0", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(completion({ content: "OK" })));
    vi.stubGlobal("fetch", fetchMock);

    const r = await chat({ messages: [{ role: "user", content: "hi" }] }, FAST);

    expect(r.message.content).toBe("OK");
    expect(r.raw_id).toBe("chatcmpl-1");
    expect(r.receipt).toEqual({
      receipt_id: "rcpt_1",
      decision_id: "dec_1",
      requested_model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      routed_model: "nvidia/nemotron-routed",
      provider: "nvidia",
      label: "fast",
      tier: "T1",
      kind: "hosted",
      input_tokens: 12,
      output_tokens: 3,
      latency_ms: 250,
      signed: true,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://nightshift.test/v1/chat/completions");
    const h = init.headers as Record<string, string>;
    expect(h["meterless-app"]).toBe("taxmap");
    expect(h["meterless-scope"]).toBe("user");
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
    const sent = JSON.parse(init.body as string);
    expect(sent.temperature).toBe(0);
    expect(sent.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
  });

  it("marks the receipt unsigned when the envelope is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(completion({ content: "OK" }, false))));
    const r = await chat({ messages: [{ role: "user", content: "hi" }] }, FAST);
    expect(r.receipt.signed).toBe(false);
  });

  it("passes tool_calls through and sends tools in the request", async () => {
    const toolCalls = [{ id: "call_1", type: "function", function: { name: "run_sql", arguments: '{"sql":"SELECT 1"}' } }];
    const fetchMock = vi.fn().mockResolvedValue(ok(completion({ content: null, tool_calls: toolCalls })));
    vi.stubGlobal("fetch", fetchMock);
    const tools = [
      { type: "function" as const, function: { name: "run_sql", parameters: { type: "object", properties: {} } } },
    ];

    const r = await chat({ messages: [{ role: "user", content: "q" }], tools, tool_choice: "auto" }, FAST);

    expect(r.message.tool_calls).toEqual(toolCalls);
    const sent = JSON.parse(((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string));
    expect(sent.tools).toEqual(tools);
    expect(sent.tool_choice).toBe("auto");
  });

  it("retries a 5xx and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(ok(completion({ content: "OK" })));
    vi.stubGlobal("fetch", fetchMock);

    const r = await chat({ messages: [{ role: "user", content: "hi" }] }, FAST);

    expect(r.message.content).toBe("OK");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chat({ messages: [{ role: "user", content: "hi" }] }, FAST)).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out when every attempt hangs", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_res, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const fetchMock = vi.fn().mockImplementation(hang);
    vi.stubGlobal("fetch", fetchMock);

    await expect(chat({ messages: [{ role: "user", content: "hi" }] }, { timeoutMs: 20, backoffMs: 1 })).rejects.toThrow(
      /timed out after 20 ms/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never lets the token appear in an error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError(`connect failed with Bearer ${TOKEN}`)));
    const netErr = await chat({ messages: [{ role: "user", content: "hi" }] }, { ...FAST, retries: 0 }).catch(
      (e: unknown) => e,
    );
    expect((netErr as Error).message).not.toContain(TOKEN);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`invalid token ${TOKEN}`, { status: 401 })));
    const httpErr = await chat({ messages: [{ role: "user", content: "hi" }] }, FAST).catch((e: unknown) => e);
    expect((httpErr as Error).message).toContain("[REDACTED]");
    expect((httpErr as Error).message).not.toContain(TOKEN);
  });

  it("appends one jsonl line per call with the receipt fields", async () => {
    const toolCalls = [{ id: "c", type: "function", function: { name: "run_sql", arguments: "{}" } }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ok(completion({ content: null, tool_calls: toolCalls }))),
    );

    await chat({ messages: [{ role: "user", content: "hi" }] }, FAST);
    await chat({ messages: [{ role: "user", content: "again" }], app: "other" }, FAST);

    const lines = readFileSync(logFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      app: "taxmap",
      requested_model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      routed_model: "nvidia/nemotron-routed",
      provider: "nvidia",
      receipt_id: "rcpt_1",
      input_tokens: 12,
      output_tokens: 3,
      latency_ms: 250,
      had_tool_calls: true,
    });
    expect(typeof lines[0].ts).toBe("string");
    expect(lines[1].app).toBe("other");
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });
});
