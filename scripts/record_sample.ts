// Runs the live pipeline for the built-in profile and records it as a sample for SAMPLE_MODE.
//   npx tsx scripts/record_sample.ts [--out path.json]
// --out writes elsewhere (for example a candidate to compare before replacing the sample).
// Writes data/samples/retail-sole-proprietor-ikeja.json: the full event trace, draft, checked claims,
// definitions and receipts. Receipts keep model, lane, provider, receipt_id, tokens and the signed
// flag; signatures and public keys are never stored (the client keeps only `signed`).
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Profile } from "../src/agents/types.js";
import { runPipeline } from "../src/api/pipeline.js";
import { samplesDir, type Sample } from "../src/api/samples.js";
import type { ReceiptRow, RunEvent } from "../src/api/types.js";
import { warmCache } from "../src/data/warm.js";

const NAME = "retail-sole-proprietor-ikeja";
const outIndex = process.argv.indexOf("--out");
const outArg = outIndex > 0 && process.argv[outIndex + 1] ? resolve(process.argv[outIndex + 1]) : undefined;
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
const question = "What taxes and levies does my business have to pay?";

/** Only the receipt fields the page shows; anything else (envelopes, signatures) is dropped. */
function cleanReceipt(r: ReceiptRow): ReceiptRow {
  const { call, agent, receipt_id, decision_id, requested_model, routed_model, provider, label, tier, kind, input_tokens, output_tokens, latency_ms, signed } = r;
  return { call, agent, receipt_id, decision_id, requested_model, routed_model, provider, label, tier, kind, input_tokens, output_tokens, latency_ms, signed };
}

const events: RunEvent[] = [];
const t = Date.now();
await warmCache();
const result = await runPipeline(profile, question, {
  onEvent: (e) => {
    events.push({ ...e, seq: events.length + 1 });
    console.log(`${String(events.length).padStart(3)} ${e.agent.padEnd(10)} ${e.text}`);
  },
});

const sample: Sample = {
  name: NAME,
  recorded_at: new Date().toISOString(),
  profile,
  question,
  events,
  result: { ...result, receipts: result.receipts.map(cleanReceipt) },
};
const file = outArg ?? join(samplesDir(), `${NAME}.json`);
await mkdir(dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(sample, null, 2), "utf-8");
const tt = result.totals;
console.log(
  `\nwrote ${file}: ${events.length} events, ${result.checked.length} claims ` +
    `(${tt.supported} supported, ${tt.qualified} qualified, ${tt.struck} struck, ${tt.unchecked} unchecked), ` +
    `${tt.model_calls} model calls, ${tt.signed_receipts} signed, ${Math.round((Date.now() - t) / 1000)} s`,
);
