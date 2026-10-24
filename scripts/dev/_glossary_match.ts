// Dev check: which definitions the glossary attaches for a few real claims.
//   npx tsx scripts/dev/_glossary_match.ts
import { corpus, matchDefinitions } from "../../src/agents/glossary.js";

const cases: Array<[string, string]> = [
  ["The sole proprietor is not liable for Companies Income Tax under NTA-2025-s56, which imposes tax only on companies.", "NTA-2025-s56"],
  ["The shop must file a Value Added Tax return by the 21st.", "NTAA-2025-s22"],
  ["VAT is payable on all taxable supplies in Nigeria.", "NTA-2025-s144"],
];
for (const [claim, id] of cases) {
  const s = corpus().get(id);
  if (!s) continue;
  console.log(`${id}: ${matchDefinitions(claim, [s]).map((d) => `${d.section_id}:${d.term}`).join(", ") || "(none)"}`);
}
