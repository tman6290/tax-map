// Dev check: glossary size per section and the definitions matched for the VAT-return claim.
import { corpus, glossary, matchDefinitions } from "../../src/agents/glossary.js";
const g = glossary();
const per = new Map<string, number>();
for (const e of g) per.set(e.section_id, (per.get(e.section_id) ?? 0) + 1);
console.log([...per].map(([k, v]) => `${k}:${v}`).join(" "), "total", g.length);
for (const t of ["small business", "small company", "taxable person", "company"]) {
  console.log(t, "->", g.filter((e) => e.term === t).map((e) => `${e.section_id}(${e.scope})`).join(", "));
}
const s22 = corpus().get("NTAA-2025-s22")!;
const m = matchDefinitions("The shop must file a Value Added Tax return on or before the 21st day of the following month.", [s22]);
for (const e of m) console.log(`${e.section_id} "${e.term}": ${e.definition.slice(0, 110)}`);
