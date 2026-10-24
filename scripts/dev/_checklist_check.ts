// Dev check: each checklist area's Parts from the map, for the sample profile.
import { areaParts, checklistAreas, describeParts } from "../../src/agents/checklist.js";
const areas = checklistAreas({ business_type: "sole_proprietor", sector: "retail", state: "Lagos", lga: "Ikeja", turnover_band: "under_25m", fixed_assets_band: "under_250m", employees: 3, has_premises: true, has_signage: true });
for (const a of areas) console.log(`(${a.key}) ${a.label}\n    ${describeParts(areaParts(a))}`);
