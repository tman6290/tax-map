import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunIngestInput } from "../../src/engines/world_model/index.js";

export function worldDirs() {
  const dir = mkdtempSync(join(tmpdir(), "wm-test-"));
  return { dataDir: join(dir, "data"), logDir: join(dir, "logs") };
}

export const S22 =
  "(1) A taxable person shall submit a return on or before the 21st day of the following month. (4) The provision of subsection (1) shall not apply to a small business.";

/** A finished run in the shape the pipeline hands the World Model. */
export function runInput(runId: string, finishedAt: string, verdict = "supported"): RunIngestInput {
  return {
    runId,
    finishedAt,
    sections: [
      { section_id: "NTAA-2025-s22", act_id: "NTAA-2025", section_no: "22", heading: "Returns for value added tax", text: S22 },
      { section_id: "NTA-2025-s147", act_id: "NTA-2025", section_no: "147", heading: "Rate of VAT", text: "VAT shall be charged at the rate of 7.5%." },
    ],
    definitions: [{ section_id: "NTAA-2025-s147", term: "small business", definition: '"small business" means a business that earns gross turnover of N50,000,000 or less' }],
    claims: [
      { id: "c1", type: "exemption", text: "As a small business the shop need not file monthly VAT returns.", section_ids: ["NTAA-2025-s22"] },
      { id: "c2", type: "obligation", text: "VAT is charged at 7.5%.", section_ids: ["NTA-2025-s147"] },
    ],
    checked: [
      {
        claim: { id: "c1", text: "As a small business the shop need not file monthly VAT returns.", section_ids: ["NTAA-2025-s22"] },
        verdict,
        reason: "subsection (4) disapplies (1) for small businesses",
        quote: "The provision of subsection (1) shall not apply to a small business.",
        quote_verified: true,
        qualifier: null,
        definitions: [{ section_id: "NTAA-2025-s147", term: "small business" }],
      },
      {
        claim: { id: "c2", text: "VAT is charged at 7.5%.", section_ids: ["NTA-2025-s147"] },
        verdict: "struck",
        reason: "text does not establish the claim",
        quote: null,
        quote_verified: false,
        qualifier: null,
      },
    ],
  };
}
