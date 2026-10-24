// Runs only the conformance suites and prints "H-MEM conformance N/N, World Model conformance N/N".
//   npm run conformance
// The suites are derived from the Implementation Checklists of the Meterless engine specs (no vendored
// suite exists); items outside the minimum build are listed below, not counted.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT = resolve("logs/conformance.json");
const NOT_IN_MINIMUM = {
  "H-MEM": [
    "Implement programmable approval boundary (auto-policy + optional supervisor agent).",
    "Implement conflict scanning + auto-resolution + uncertainty escalation.",
    "Implement dream proposal cycle and sleep preview/execute/backup/restore.",
    "Add metrics: memory health, retrieval hit rate, conflict rate, approval throughput.",
  ],
  "World Model": [
    "Implement snapshot creation, stream ingest, and bulk/migration jobs.",
    "Implement semantic capture (symbolic/textual/vector) + continuity anchors; mount H-MEM for memory tiers.",
    "Implement enrichment as first-class queued jobs behind a provider adapter.",
    "Implement the headless control plane (query / mutation / maintenance endpoints + alert events).",
    "Implement the supervisor/maintenance agent + policy + programmable confirmation for destructive ops.",
    "Implement per-aggregate FIFO queues, job typing, cancellation, lifecycle-decoupled coordination.",
  ],
};

mkdirSync(resolve("logs"), { recursive: true });
const vitest = resolve("node_modules/vitest/vitest.mjs");
const run = spawnSync(process.execPath, [vitest, "run", "tests/conformance", "--reporter=json", `--outputFile=${OUT}`], { encoding: "utf-8" });

interface JsonReport {
  testResults: Array<{ name: string; assertionResults: Array<{ title: string; status: string }> }>;
}
let report: JsonReport;
try {
  report = JSON.parse(readFileSync(OUT, "utf-8")) as JsonReport;
} catch {
  console.error(run.stdout, run.stderr);
  console.error("conformance: vitest produced no report");
  process.exit(1);
}

const suite = (file: string) => {
  const r = report.testResults.find((t) => t.name.replace(/\\/g, "/").endsWith(file));
  const tests = r?.assertionResults ?? [];
  return { passed: tests.filter((t) => t.status === "passed").length, total: tests.length, failed: tests.filter((t) => t.status !== "passed").map((t) => t.title) };
};
const h = suite("tests/conformance/hmem.conformance.test.ts");
const w = suite("tests/conformance/world_model.conformance.test.ts");

for (const [name, s] of [["H-MEM", h], ["World Model", w]] as const) {
  for (const f of s.failed) console.log(`FAIL ${name}: ${f}`);
}
console.log(`\nNot in the minimum build (not counted):`);
for (const [engine, items] of Object.entries(NOT_IN_MINIMUM)) for (const i of items) console.log(`  ${engine}: ${i}`);
console.log(`\nH-MEM conformance ${h.passed}/${h.total}, World Model conformance ${w.passed}/${w.total}`);
console.log(`(report: ${join("logs", "conformance.json")})`);
process.exit(h.passed === h.total && w.passed === w.total && h.total > 0 && w.total > 0 ? 0 : 1);
