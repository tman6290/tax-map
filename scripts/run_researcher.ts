// Run the Researcher once, live, on a sample profile.
//   npx tsx scripts/run_researcher.ts ["question"]
import "dotenv/config";
import { research } from "../src/agents/researcher.js";
import type { Profile } from "../src/agents/types.js";
import { InMemoryRunMemory } from "../src/engines/hmem/index.js";

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

const result = await research(profile, question, new InMemoryRunMemory());

console.log(JSON.stringify(result.draft, null, 2));
console.log("\n--- trace summary");
let turn = 0;
for (const step of result.trace) {
  const d = step.detail as Record<string, unknown>;
  if (step.kind === "model_turn") {
    turn++;
    const calls = (d.tool_calls as string[]).join(", ") || "final answer";
    console.log(`turn ${turn}: ${step.receipt?.routed_model} -> ${calls}`);
  } else if (step.kind === "tool_result") {
    const what =
      d.tool === "run_sql" ? String(d.sql_run ?? d.sql_requested) : `get_sections ${JSON.stringify(d.requested ?? [])}`;
    console.log(`  ${d.error ? "ERROR" : `${d.row_count} rows`}: ${what}${d.error ? ` (${d.error})` : ""}`);
  }
}
const tokensIn = result.receipts.reduce((n, r) => n + r.input_tokens, 0);
const tokensOut = result.receipts.reduce((n, r) => n + r.output_tokens, 0);
const models = [...new Set(result.receipts.map((r) => r.routed_model))].join(", ");
console.log(`receipts: ${result.receipts.length} (${result.receipts.filter((r) => r.signed).length} signed), routed: ${models}`);
console.log(`tokens: ${tokensIn} in + ${tokensOut} out = ${tokensIn + tokensOut}`);
