import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "../agents/types.js";
import type { PipelineOutput, ReceiptRow, RunEvent } from "./types.js";

/** A recorded live run, replayed in sample mode (written by scripts/record_sample.ts). */
export interface Sample {
  name: string;
  recorded_at: string;
  profile: Profile;
  question: string;
  events: RunEvent[];
  result: PipelineOutput;
}

/**
 * Only the receipt fields the page shows; anything else (envelopes, signatures) is dropped before a
 * receipt is stored in a sample.
 */
export function sampleReceipt(r: ReceiptRow): ReceiptRow {
  const { call, agent, receipt_id, decision_id, requested_model, routed_model, provider, label, tier, kind, input_tokens, output_tokens, latency_ms, signed } = r;
  return { call, agent, receipt_id, decision_id, requested_model, routed_model, provider, label, tier, kind, input_tokens, output_tokens, latency_ms, signed };
}

export function samplesDir(): string {
  if (process.env.SAMPLES_DIR) return resolve(process.env.SAMPLES_DIR);
  const fromModule = fileURLToPath(new URL("../../data/samples", import.meta.url));
  return existsSync(fromModule) ? fromModule : resolve(process.cwd(), "data/samples");
}

export function loadSamples(dir: string = samplesDir()): Sample[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as Sample);
}

/** The sample whose profile matches the most fields of `profile`; the first sample when none match. */
export function pickSample(samples: Sample[], profile: Profile): Sample | undefined {
  let best: Sample | undefined;
  let bestScore = 0;
  for (const s of samples) {
    const score = (Object.keys(profile) as Array<keyof Profile>).filter(
      (k) => String(s.profile[k]).toLowerCase() === String(profile[k]).toLowerCase(),
    ).length;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best ?? samples[0];
}
