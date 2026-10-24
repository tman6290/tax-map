// Re-runs the Critic's plain-words check on every claim of a recorded sample, without re-recording it.
//   npx tsx scripts/recheck_plain.ts [path.json] [--claims c6,c7]
// --claims limits the recheck to those claim ids; the other claims are left as they are.
// Default path: data/samples/retail-sole-proprietor-ikeja.json. For each checked claim, the
// Researcher's drafted plain line (from the draft) is checked against the legal sentence: one Critic
// call per claim, no tools, 60 s (checkPlain in src/agents/critic.ts). The file is updated in place:
// each claim's plain and plain_checked, its Why text cleaned as critique() now cleans it, the verdict
// events' copies of the claims, the new receipts (appended), the totals, and one trace event per check
// so the run log shows the recheck. Prints one line per claim.
import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkPlain, cleanReason, criticModel } from "../src/agents/critic.js";
import type { CheckedClaim, TraceStep } from "../src/agents/types.js";
import { criticDetail, describeCriticStep } from "../src/api/describe.js";
import { sampleReceipt, samplesDir, type Sample } from "../src/api/samples.js";
import type { RunEvent } from "../src/api/types.js";
import type { Receipt } from "../src/providers/index.js";

const args = process.argv.slice(2);
const claimsAt = args.indexOf("--claims");
const only = claimsAt >= 0 ? new Set((args[claimsAt + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) : null;
const positional = args.filter((_a, i) => claimsAt < 0 || (i !== claimsAt && i !== claimsAt + 1));
const path = positional[0] ? resolve(positional[0]) : join(samplesDir(), "retail-sole-proprietor-ikeja.json");
const sample = JSON.parse(await readFile(path, "utf-8")) as Sample;
const r = sample.result;
const model = criticModel();
const drafted = new Map(r.draft.claims.map((c) => [c.id, c.plain ?? ""]));

const steps: TraceStep[] = [];
const fresh: Receipt[] = [];
const targets = r.checked.filter((c) => !only || only.has(c.claim.id));
const unknown = only ? [...only].filter((id) => !targets.some((c) => c.claim.id === id)) : [];
if (unknown.length || targets.length === 0) throw new Error(`--claims names ids not in the sample: ${unknown.join(", ") || "(none given)"}`);
console.log(`rechecking ${targets.length} plain line(s) in ${path} with ${model}\n`);

for (const c of targets) {
  const before = drafted.get(c.claim.id) || c.claim.plain || "";
  const receipts: Receipt[] = [];
  const trace: TraceStep[] = [];
  const out = await checkPlain({ ...c.claim, plain: before }, model, receipts, trace);
  c.claim.plain = out.plain;
  c.plain_checked = out.checked;
  c.reason = cleanReason(c.reason);
  fresh.push(...receipts);
  steps.push(...trace);

  const d = (trace[0]?.detail ?? {}) as { ok?: boolean | null; error?: string };
  const outcome = !before
    ? "no plain line"
    : d.ok === true
      ? "passed"
      : d.ok === false
        ? out.plain
          ? `fixed: "${before}" -> "${out.plain}"`
          : `dropped (no fix given): "${before}"`
        : `not checked (${d.error ?? "no reply"})`;
  console.log(`${c.claim.id.padEnd(4)} ${c.verdict.padEnd(10)} ${outcome}`);
  if (d.ok === true) console.log(`     "${out.plain}"`);
}

// the replay's verdict events carry their own copy of each claim
const byId = new Map<string, CheckedClaim>(r.checked.map((c) => [c.claim.id, c]));
for (const e of sample.events) {
  if (e.type !== "verdict") continue;
  const id = (e.data as CheckedClaim | undefined)?.claim?.id;
  if (id && byId.has(id)) e.data = byId.get(id);
}

// one trace event per check, before the result, so the run log shows the recheck
const resultAt = sample.events.findIndex((e) => e.type === "result");
const added: RunEvent[] = steps.map((step) => ({ seq: 0, type: "trace", ts: step.ts, agent: "critic", text: describeCriticStep(step), detail: `${criticDetail(step)} (recheck)`, data: step }));
sample.events.splice(resultAt < 0 ? sample.events.length : resultAt, 0, ...added);
sample.events.forEach((e, i) => (e.seq = i + 1));

// receipts and totals
const first = r.receipts.length + 1;
r.receipts.push(...fresh.map((x, i) => sampleReceipt({ ...x, agent: "critic", call: first + i })));
r.totals = {
  ...r.totals,
  tokens_in: r.receipts.reduce((n, x) => n + x.input_tokens, 0),
  tokens_out: r.receipts.reduce((n, x) => n + x.output_tokens, 0),
  model_calls: r.receipts.length,
  signed_receipts: r.receipts.filter((x) => x.signed).length,
};

await writeFile(path, JSON.stringify(sample, null, 2), "utf-8");
const checked = r.checked.filter((c) => c.plain_checked).length;
console.log(`\n${checked} of ${r.checked.length} plain lines checked; ${fresh.length} Critic calls (${fresh.filter((x) => x.signed).length} signed); wrote ${path}`);
