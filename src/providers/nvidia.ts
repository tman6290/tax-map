// Direct NVIDIA API route, used only as a flagged fallback for the Critic (see providers/index.ts).
// Calls bypass Meterless, so they carry no signed receipt: receipt_id is empty and signed is false.
import { appendJsonl } from "../logging/jsonl.js";
import type { ChatOptions, ChatResult, ChatRuntimeOptions } from "./meterless.js";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_LOG_FILE = "logs/model_calls.jsonl";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function nvidiaChat(opts: ChatOptions, runtime: ChatRuntimeOptions = {}): Promise<ChatResult> {
  const { timeoutMs = 60_000, retries = 2, backoffMs = 500 } = runtime;
  const key = process.env.NVIDIA_API_KEY ?? "";
  const model = opts.model ?? process.env.METERLESS_MODEL;
  if (!key || !model) throw new Error("NVIDIA_API_KEY and a model must be set for the nvidia-direct provider");
  const redact = (s: string) => s.split(key).join("[REDACTED]");
  const body = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0,
    ...(opts.max_tokens !== undefined ? { max_tokens: opts.max_tokens } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.tool_choice !== undefined ? { tool_choice: opts.tool_choice } : {}),
    ...(opts.extra_body ?? {}),
  };

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(NVIDIA_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = new Error(redact(`Cannot reach NVIDIA API: ${err instanceof Error ? err.message : String(err)}`));
      continue;
    }
    if (res.status >= 500) {
      lastError = new Error(`NVIDIA API server error: HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) {
      const detail = redact((await res.text().catch(() => "")).slice(0, 500));
      throw new Error(`NVIDIA API rejected the request: HTTP ${res.status} ${detail}`.trim());
    }
    const json = (await res.json()) as {
      id?: string;
      model?: string;
      choices?: Array<{ message?: ChatResult["message"] }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = json.choices?.[0]?.message;
    if (!message) throw new Error("NVIDIA API response had no choices[0].message");
    const receipt = {
      receipt_id: "",
      decision_id: "",
      requested_model: model,
      routed_model: json.model ?? model,
      provider: "nvidia-direct",
      label: "direct",
      tier: "",
      kind: "direct",
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
      latency_ms: Date.now() - started,
      signed: false,
    };
    await appendJsonl(process.env.METERLESS_LOG_FILE ?? DEFAULT_LOG_FILE, {
      ts: new Date().toISOString(),
      app: opts.app ?? "",
      requested_model: receipt.requested_model,
      routed_model: receipt.routed_model,
      provider: receipt.provider,
      receipt_id: "",
      input_tokens: receipt.input_tokens,
      output_tokens: receipt.output_tokens,
      latency_ms: receipt.latency_ms,
      had_tool_calls: (message.tool_calls?.length ?? 0) > 0,
    });
    return { message: { ...message, role: "assistant" }, receipt, raw_id: json.id ?? "" };
  }
  throw lastError ?? new Error("NVIDIA API request failed");
}
