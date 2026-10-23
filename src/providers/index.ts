// AI provider registry. Meterless Runtime (the Nightshift gateway) is the app's primary provider:
// every call goes through it and carries a signed compute receipt. "nvidia-direct" exists only as
// an opt-in fallback for the Critic, enabled by CRITIC_DIRECT_NVIDIA=true with NVIDIA_API_KEY.
import { chat as meterlessChat, type ChatOptions, type ChatResult, type ChatRuntimeOptions } from "./meterless.js";
import { nvidiaChat } from "./nvidia.js";

export * from "./meterless.js";

export type ProviderName = "meterless" | "nvidia-direct";

export interface Provider {
  name: ProviderName;
  description: string;
  chat(opts: ChatOptions, runtime?: ChatRuntimeOptions): Promise<ChatResult>;
}

export const PRIMARY_PROVIDER: ProviderName = "meterless";

export const providers: Record<ProviderName, Provider> = {
  meterless: {
    name: "meterless",
    description: "Meterless Runtime (Nightshift gateway): primary provider, signed compute receipts",
    chat: meterlessChat,
  },
  "nvidia-direct": {
    name: "nvidia-direct",
    description: "Direct NVIDIA API: fallback only, behind CRITIC_DIRECT_NVIDIA, no receipts",
    chat: nvidiaChat,
  },
};

export function directNvidiaEnabled(): boolean {
  return process.env.CRITIC_DIRECT_NVIDIA === "true" && Boolean(process.env.NVIDIA_API_KEY);
}

/**
 * Calls the primary provider; only when that fails after its retries and the direct NVIDIA
 * fallback is enabled, retries the same request there (with a warning, since it has no receipt).
 */
export async function chatWithFallback(opts: ChatOptions, runtime?: ChatRuntimeOptions): Promise<ChatResult> {
  try {
    return await providers[PRIMARY_PROVIDER].chat(opts, runtime);
  } catch (err) {
    if (!directNvidiaEnabled()) throw err;
    console.warn(
      `WARNING: ${PRIMARY_PROVIDER} failed (${err instanceof Error ? err.message : String(err)}); ` +
        "retrying on nvidia-direct because CRITIC_DIRECT_NVIDIA=true. This call has no signed receipt.",
    );
    return providers["nvidia-direct"].chat(opts, runtime);
  }
}
