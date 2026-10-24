// Dev probe: send the Critic prompt for the VAT-return claim with variants of NTAA-2025-s22, one
// call each with no retries, to see which inputs Nightshift answers and how long they take.
//   npx tsx scripts/dev/_probe_critic.ts
import "dotenv/config";
import { criticSystemPrompt, packPieces, splitSubsections } from "../../src/agents/critic.js";
import { runSql } from "../../src/data/zetaris.js";
import { chat } from "../../src/providers/meterless.js";

const r = await runSql("SELECT text FROM taxmap.sections WHERE section_id = 'NTAA-2025-s22'");
const text = String(r.rows[0]?.[0]);
const variants: Record<string, string> = {
  full: text,
  first_600: text.slice(0, 600),
  piece_1_of_800: packPieces(splitSubsections(text), 800)[0] ?? "",
};
for (const [name, body] of Object.entries(variants)) {
  const user =
    "Business profile: sole_proprietor, retail, Lagos, under_25m turnover.\n\n" +
    "Claim: The shop must file a VAT return on or before the 21st day of the following month.\n\n" +
    `Operative text:\n\n--- NTAA-2025-s22\n${body}`;
  const t = Date.now();
  try {
    const res = await chat(
      {
        messages: [
          { role: "system", content: criticSystemPrompt() },
          { role: "user", content: user },
        ],
        app: "taxmap-critic",
        model: process.env.METERLESS_CRITIC_MODEL || "nvidia/nemotron-3-ultra-550b-a55b",
      },
      { retries: 0, timeoutMs: 180_000 },
    );
    console.log(`${name} (${body.length} chars): ok in ${Date.now() - t} ms, ${res.receipt.output_tokens} out, routed ${res.receipt.routed_model}`);
  } catch (e) {
    console.log(`${name} (${body.length} chars): ${(e as Error).message} after ${Date.now() - t} ms`);
  }
}
