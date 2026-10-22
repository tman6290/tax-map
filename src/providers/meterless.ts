import { appendJsonl } from "../logging/jsonl.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export type Receipt = {
  receipt_id: string;
  decision_id: string;
  requested_model: string;
  routed_model: string;
  provider: string;
  label: string;
  tier: string;
  kind: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  /** True when the receipt carries a signature envelope (pubkey and signature). The signature is not verified here. */
  signed: boolean;
};

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  app?: string;
}

export interface ChatResult {
  message: ChatMessage;
  receipt: Receipt;
  raw_id: string;
}

export interface ChatRuntimeOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_LOG_FILE = "logs/model_calls.jsonl";

function redact(text: string, token: string): string {
  return token ? text.split(token).join("[REDACTED]") : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parseReceipt(body: Record<string, unknown>, requestedModel: string): Receipt {
  const m = (body.meterless ?? {}) as Record<string, unknown>;
  const route = (m.winning_route ?? {}) as Record<string, unknown>;
  const usage = (m.usage ?? {}) as Record<string, unknown>;
  const env = (m.receipt_envelope ?? {}) as Record<string, unknown>;
  return {
    receipt_id: str(m.receipt_id),
    decision_id: str(m.decision_id),
    requested_model: str(m.requested_model) || requestedModel,
    routed_model: str(m.routed_model) || str(route.model) || str(body.model),
    provider: str(route.provider),
    label: str(route.label),
    tier: str(route.tier),
    kind: str(route.kind),
    input_tokens: num(usage.input_tokens),
    output_tokens: num(usage.output_tokens),
    latency_ms: num(usage.latency_ms),
    signed: str(env.pubkey_b64) !== "" && str(env.sig_b64) !== "",
  };
}

/**
 * One chat completion through the Nightshift gateway (plain fetch, so the extra `meterless`
 * receipt field survives). 60 s timeout per attempt, up to 2 retries with backoff on network
 * errors and 5xx, none on 4xx. Errors never contain the runtime token.
 */
export async function chat(opts: ChatOptions, runtime: ChatRuntimeOptions = {}): Promise<ChatResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, backoffMs = DEFAULT_BACKOFF_MS } = runtime;
  const base = process.env.METERLESS_BASE_URL?.replace(/\/$/, "");
  const token = process.env.METERLESS_RUNTIME_TOKEN ?? "";
  const model = process.env.METERLESS_MODEL;
  if (!base || !token || !model) {
    throw new Error("METERLESS_BASE_URL, METERLESS_RUNTIME_TOKEN and METERLESS_MODEL must be set in .env");
  }
  const app = opts.app ?? (process.env.METERLESS_APP || "taxmap");

  const body = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0,
    ...(opts.max_tokens !== undefined ? { max_tokens: opts.max_tokens } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.tool_choice !== undefined ? { tool_choice: opts.tool_choice } : {}),
  };

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "meterless-app": app,
          "meterless-scope": "user",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      lastError = new Error(
        timedOut
          ? `Meterless request timed out after ${timeoutMs} ms`
          : redact(`Cannot reach Meterless: ${err instanceof Error ? err.message : String(err)}`, token),
      );
      continue;
    }

    if (res.status >= 500) {
      lastError = new Error(`Meterless server error: HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) {
      const detail = redact((await res.text().catch(() => "")).slice(0, 500), token);
      throw new Error(`Meterless rejected the request: HTTP ${res.status} ${detail}`.trim());
    }

    const json = (await res.json()) as Record<string, unknown>;
    const choice = (json.choices as Array<{ message?: ChatMessage }> | undefined)?.[0];
    if (!choice?.message) throw new Error("Meterless response had no choices[0].message");
    const receipt = parseReceipt(json, model);
    const message: ChatMessage = { ...choice.message, role: "assistant" };

    await appendJsonl(process.env.METERLESS_LOG_FILE ?? DEFAULT_LOG_FILE, {
      ts: new Date().toISOString(),
      app,
      requested_model: receipt.requested_model,
      routed_model: receipt.routed_model,
      provider: receipt.provider,
      receipt_id: receipt.receipt_id,
      input_tokens: receipt.input_tokens,
      output_tokens: receipt.output_tokens,
      latency_ms: receipt.latency_ms,
      had_tool_calls: (message.tool_calls?.length ?? 0) > 0,
    });
    return { message, receipt, raw_id: str(json.id) };
  }
  throw lastError ?? new Error("Meterless request failed");
}
