// Researcher then Critic on the sample profile, live.
//   npx tsx scripts/run_pipeline.ts ["question"]
import "dotenv/config";
import { critique } from "../src/agents/critic.js";
import { research } from "../src/agents/researcher.js";
import type { Profile } from "../src/agents/types.js";
import { InMemoryRunMemory } from "../src/engines/hmem/index.js";
import { InMemoryWorldModel } from "../src/engines/world_model/index.js";

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
const question = process.argv[2] ?? "What taxes and levies does my shop have to pay?";

const res = await research(profile, question, new InMemoryRunMemory());
console.log(`research: ${res.draft.claims.length} claims, ${Object.keys(res.sections_read).length} sections read`);
for (const c of res.draft.claims) console.log(`  ${c.id}: ${c.text}`);

const crit = await critique(res.draft, res.sections_read, profile, new InMemoryWorldModel());

const cell = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));
console.log("");
console.log(`${cell("claim", 6)} ${cell("verdict", 10)} ${cell("cited", 30)} ${cell("quote ok", 9)} ${cell("routed model", 40)} qualifier / reason`);
for (const c of crit.checked) {
  const why = (c.qualifier ?? c.reason).replace(/\s+/g, " ").slice(0, 120);
  console.log(
    `${cell(c.claim.id, 6)} ${cell(c.verdict, 10)} ${cell(c.claim.section_ids.join(","), 30)} ${cell(String(c.quote_verified), 9)} ${cell(c.receipt?.routed_model ?? "-", 40)} ${why}`,
  );
}

const count = (v: string) => crit.checked.filter((c) => c.verdict === v).length;
const all = [...res.receipts, ...crit.receipts];
const tokens = all.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0);
console.log("");
console.log(`supported ${count("supported")}, qualified ${count("qualified")}, struck ${count("struck")}`);
console.log(`receipts: ${all.length} (${all.filter((r) => r.signed).length} signed): researcher ${res.receipts.length}, critic ${crit.receipts.length}`);
console.log(`tokens: ${tokens} total across both agents`);
