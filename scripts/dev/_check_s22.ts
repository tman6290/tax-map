// Dev probe: run the Critic on the VAT-return claim against the full text of NTAA-2025-s22.
//   npx tsx scripts/dev/_check_s22.ts
import "dotenv/config";
import { critique } from "../../src/agents/critic.js";
import type { Profile } from "../../src/agents/types.js";
import { runSql } from "../../src/data/zetaris.js";
import { InMemoryWorldModel } from "../../src/engines/world_model/index.js";

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
const r = await runSql(
  "SELECT section_id, act_id, section_no, heading, text FROM taxmap.sections WHERE section_id = 'NTAA-2025-s22'",
);
const [id, act, no, heading, text] = r.rows[0] as string[];
console.log(`${id}: ${text.length} chars of text`);
const t = Date.now();
const out = await critique(
  {
    claims: [
      {
        id: "c3",
        text: "The shop must file a Value Added Tax return on or before the 21st day of the following month.",
        section_ids: [id],
        tier: "federal",
        agency: "Nigeria Revenue Service",
      },
    ],
    notes: [],
    unanswered: [],
  },
  { [id]: { heading, text, act_id: act, section_no: no } },
  profile,
  new InMemoryWorldModel(),
);
const c = out.checked[0];
console.log(
  JSON.stringify(
    {
      ms: Date.now() - t,
      verdict: c?.verdict,
      quote_verified: c?.quote_verified,
      qualifier: c?.qualifier,
      reason: c?.reason,
      quote: c?.quote,
      routed: c?.receipt?.routed_model,
      signed: c?.receipt?.signed,
      pieces: out.trace.filter((s) => (s.detail as { piece?: unknown }).piece !== undefined).map((s) => s.detail),
    },
    null,
    2,
  ),
);
