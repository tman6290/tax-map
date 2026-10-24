// Runs the live pipeline for the built-in profile and records it as a sample for SAMPLE_MODE.
//   npx tsx scripts/record_sample.ts [--attempts N] [--min-claims N] [--min-supported N] [--out path.json]
// Runs the pipeline up to --attempts times (default 1) and keeps the run with the most supported
// claims among those with at least --min-claims claims and --min-supported supported (both default
// 0). If no attempt meets both minimums, nothing is written and the existing sample stays.
// --out writes elsewhere (for example a candidate to compare before replacing the sample).
// Default output: data/samples/retail-sole-proprietor-ikeja.json, holding the full event trace,
// draft, checked claims (with each claim's plain-words line and plain_checked), definitions and receipts. Receipts keep model, lane, provider, receipt_id,
// tokens and the signed flag; signatures and public keys are never stored (the client keeps only
// `signed`).
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Profile } from "../src/agents/types.js";
import { runPipeline } from "../src/api/pipeline.js";
import { sampleReceipt, samplesDir, type Sample } from "../src/api/samples.js";
import type { PipelineOutput, RunEvent } from "../src/api/types.js";
import { warmCache } from "../src/data/warm.js";

const NAME = "retail-sole-proprietor-ikeja";
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

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function intArg(name: string, fallback: number): number {
  const v = arg(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got "${v}"`);
  return n;
}

const attempts = Math.max(1, intArg("--attempts", 1));
const minClaims = intArg("--min-claims", 0);
const minSupported = intArg("--min-supported", 0);
const out = arg("--out") ? resolve(String(arg("--out"))) : join(samplesDir(), `${NAME}.json`);

interface Attempt {
  n: number;
  events: RunEvent[];
  result?: PipelineOutput;
  error?: string;
  seconds: number;
}

const counts = (r: PipelineOutput) => {
  const t = r.totals;
  // plain-words lines: drafted by the Researcher (claim.plain), confirmed or fixed by the Critic (plain_checked)
  const drafted = r.checked.filter((c) => c.claim.plain).length;
  const checked = r.checked.filter((c) => c.plain_checked).length;
  return (
    `${r.checked.length} claims (${t.supported} supported, ${t.qualified} qualified, ${t.struck} struck, ${t.unchecked} unchecked), ` +
    `${drafted} with a plain line, ${checked} plain_checked, ${t.model_calls} model calls, ${t.signed_receipts} signed`
  );
};
const meets = (r: PipelineOutput) => r.checked.length >= minClaims && r.totals.supported >= minSupported;

console.log(`recording up to ${attempts} attempt(s); keep the best with >= ${minClaims} claims and >= ${minSupported} supported`);
await warmCache();

const done: Attempt[] = [];
for (let n = 1; n <= attempts; n++) {
  const t = Date.now();
  const events: RunEvent[] = [];
  console.log(`\n=== attempt ${n} of ${attempts}`);
  try {
    const result = await runPipeline(profile, question, {
      onEvent: (e) => {
        events.push({ ...e, seq: events.length + 1 });
        if (e.text) console.log(`${String(events.length).padStart(3)} ${e.agent.padEnd(10)} ${e.text}`);
      },
    });
    done.push({ n, events, result, seconds: Math.round((Date.now() - t) / 1000) });
  } catch (err) {
    // a failed attempt (for example a gateway error after retries) does not stop the others
    done.push({ n, events, error: err instanceof Error ? err.message : String(err), seconds: Math.round((Date.now() - t) / 1000) });
  }
  const a = done[done.length - 1];
  console.log(
    `attempt ${n}: ${a?.result ? `${counts(a.result)}${meets(a.result) ? "" : " (below the minimums)"}` : `failed: ${a?.error}`}, ${a?.seconds} s`,
  );
}

console.log("\n=== summary");
for (const a of done) console.log(`attempt ${a.n}: ${a.result ? counts(a.result) : `failed: ${a.error}`}, ${a.seconds} s`);

const qualifying = done.filter((a): a is Attempt & { result: PipelineOutput } => a.result !== undefined && meets(a.result));
qualifying.sort((x, y) => y.result.totals.supported - x.result.totals.supported || y.result.checked.length - x.result.checked.length);
const best = qualifying[0];
if (!best) {
  console.log(`\nno attempt met the minimums (>= ${minClaims} claims, >= ${minSupported} supported); nothing written, the existing sample is unchanged`);
  process.exit(2);
}

const sample: Sample = {
  name: NAME,
  recorded_at: new Date().toISOString(),
  profile,
  question,
  events: best.events,
  result: { ...best.result, receipts: best.result.receipts.map(sampleReceipt) },
};
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(sample, null, 2), "utf-8");
console.log(`\nkept attempt ${best.n}: ${counts(best.result)}; wrote ${out} (${best.events.length} events)`);
