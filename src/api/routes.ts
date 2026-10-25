import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { corpus } from "../agents/glossary.js";
import { isItemId, itemLabel, levies } from "../agents/levies.js";
import type { CheckedClaim, Profile, TraceStep } from "../agents/types.js";
import { collectorFor } from "../agents/collector.js";
import { criticDetail, describeCriticStep, describeHandoff, describeResearcherStep, describeVerdict, handoffDetail, pageLists, researcherDetail, verdictDetail } from "./describe.js";
import { getEngines } from "../engines/index.js";
import { mineRunOutcome, runIngestInput } from "./engine_io.js";
import { runPipeline } from "./pipeline.js";
import { RunStore, runsDir, type Run } from "./runs.js";
import { loadSamples, pickSample } from "./samples.js";
import type { RunEvent, RunResult } from "./types.js";

export const ProfileSchema = z.object({
  business_type: z.enum(["sole_proprietor", "company", "partnership"]),
  sector: z.string().trim().min(1).max(80),
  state: z.literal("Lagos"),
  lga: z.string().trim().min(1).max(80),
  turnover_band: z.enum(["under_25m", "25m_to_100m", "over_100m"]),
  fixed_assets_band: z.enum(["under_250m", "over_250m"]),
  employees: z.number().int().min(0).max(1_000_000),
  has_premises: z.boolean(),
  has_signage: z.boolean(),
});
export const RunRequestSchema = z.object({
  profile: ProfileSchema,
  question: z.string().trim().min(3).max(500),
});

const SECTION_ID_RE = /^(?:(?:NTA|NTAA|NRSEA|JRBEA)-2025|TLA-1998)-s\d+$/;
const sampleMode = () => process.env.SAMPLE_MODE === "true";
const sampleDelay = () => {
  const n = Number(process.env.SAMPLE_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 200;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function actsFile(): string {
  const fromModule = fileURLToPath(new URL("../../data/statutes/acts.json", import.meta.url));
  return existsSync(fromModule) ? fromModule : resolve(process.cwd(), "data/statutes/acts.json");
}

async function startLive(store: RunStore, run: Run, profile: Profile, question: string): Promise<void> {
  try {
    const out = await runPipeline(profile, question, { onEvent: (e) => store.emit(run, e) }, { runId: run.id });
    await store.complete(run, {
      ...out,
      page: pageLists(out.draft, out.profile),
      run_id: run.id,
      mode: "live",
      started_at: run.started_at,
      finished_at: new Date().toISOString(),
    });
  } catch (err) {
    store.fail(run, err instanceof Error ? err.message : String(err));
  }
}

const RECORDED_HANDOFF = /^Researcher finished: (\d+) claims from (\d+) sections read(?:, using (\d+) memories from earlier runs)?\. Critic started$/;

/** A recorded event's plain line and technical line, in the current wording. */
function redescribe(e: RunEvent): { text: string; detail: string } {
  try {
    if (e.type === "trace" && e.agent === "researcher") return { text: describeResearcherStep(e.data as TraceStep), detail: researcherDetail(e.data as TraceStep) };
    if (e.type === "trace" && e.agent === "critic") return { text: describeCriticStep(e.data as TraceStep), detail: criticDetail(e.data as TraceStep) };
    if (e.type === "verdict") return { text: describeVerdict(e.data as CheckedClaim), detail: verdictDetail(e.data as CheckedClaim) };
    const h = RECORDED_HANDOFF.exec(e.text);
    if (h) {
      const [claims, sections, prior] = [Number(h[1]), Number(h[2]), Number(h[3] ?? 0)];
      return { text: describeHandoff(claims, sections, prior), detail: handoffDetail(claims, sections, prior) };
    }
  } catch {
    // a step recorded in an older shape: keep its recorded line
  }
  return { text: e.text, detail: e.detail ?? e.text };
}

/** "24 October 2026" */
const longDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Replays a recorded run with short delays, without calling any model or Zetaris. */
async function startSample(store: RunStore, run: Run, profile: Profile): Promise<void> {
  const sample = pickSample(loadSamples(), profile);
  if (!sample) {
    store.fail(run, "SAMPLE_MODE is on but data/samples has no sample; run scripts/record_sample.ts");
    return;
  }
  store.emit(run, {
    type: "status",
    ts: new Date().toISOString(),
    agent: "system",
    text: `Sample run: replaying an answer recorded on ${longDate(sample.recorded_at)}`,
    detail: `Sample run: replaying the recorded run "${sample.name}" (recorded ${sample.recorded_at.slice(0, 10)})`,
    data: { sample: sample.name },
  });
  for (const e of sample.events) {
    if (e.type === "result") continue;
    // describe recorded steps with the current wording, so older samples read like live runs
    const { text, detail } = redescribe(e);
    if (text) await sleep(sampleDelay()); // silent steps (tool calls) cost no replay time
    store.emit(run, { type: e.type, ts: new Date().toISOString(), agent: e.agent, text, detail, data: e.data });
  }
  await sleep(sampleDelay());
  // the engines see the recorded run under a stable id, so replaying it again changes nothing
  const worldRunId = `sample:${sample.name}`;
  const { hmem, world } = getEngines();
  // a sample recorded before collectors existed gets them now, from the same rules a live run uses
  const r = { ...sample.result, checked: sample.result.checked.map((c) => (c.collector ? c : { ...c, collector: collectorFor(c.claim, sample.profile) })) };
  hmem.startRun(worldRunId);
  world.ingestRun(runIngestInput(worldRunId, sample.recorded_at, r.sections_read.map((s) => s.section_id), r.draft, r.checked));
  mineRunOutcome(hmem, worldRunId, r.checked);
  hmem.endRun(worldRunId);
  await store.complete(run, {
    ...r,
    page: pageLists(r.draft, sample.profile),
    run_id: run.id,
    mode: "sample",
    sample: sample.name,
    world_run_id: worldRunId,
    memory: hmem.stats(worldRunId),
    world: world.stats(worldRunId),
    started_at: run.started_at,
    finished_at: new Date().toISOString(),
  });
}

function sseWrite(res: Response, e: RunEvent): void {
  res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

export function createApiRouter(store: RunStore = new RunStore()): express.Router {
  const router = express.Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  router.post("/runs", (req: Request, res: Response) => {
    const parsed = RunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      return;
    }
    const mode = sampleMode() ? "sample" : "live";
    const run = store.create(randomUUID(), mode);
    const { profile, question } = parsed.data;
    // any error inside a run fails that run rather than leaving its event stream open
    (mode === "sample" ? startSample(store, run, profile) : startLive(store, run, profile, question)).catch((err: unknown) =>
      store.fail(run, err instanceof Error ? err.message : String(err)),
    );
    res.status(202).json({ run_id: run.id, mode });
  });

  router.get("/runs/:id/events", (req: Request, res: Response) => {
    const run = store.get(String(req.params.id));
    if (!run) {
      res.status(404).json({ error: "unknown run" });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const e of run.events) sseWrite(res, e);
    if (run.status !== "running") {
      res.end();
      return;
    }
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    const unsubscribe = store.subscribe(run.id, (e) => {
      sseWrite(res, e);
      if (e.type === "result" || e.type === "failed") {
        clearInterval(keepAlive);
        unsubscribe();
        res.end();
      }
    });
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  /** The stored result plus the run's verified facts, read from the World Model now. */
  const withFacts = (r: RunResult): RunResult => ({ ...r, verified_facts: getEngines().world.verifiedFacts(r.world_run_id ?? r.run_id) });

  router.get("/runs/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const run = store.get(id);
    if (run?.status === "complete" && run.result) {
      res.json(withFacts(run.result));
      return;
    }
    if (run?.status === "running") {
      res.status(202).json({ run_id: id, status: "running" });
      return;
    }
    if (run?.status === "failed") {
      res.status(500).json({ run_id: id, status: "failed", error: run.error });
      return;
    }
    // runs from an earlier process are read back from logs/runs
    const file = join(runsDir(), `${id}.json`);
    if (/^[0-9a-f-]{36}$/.test(id) && existsSync(file)) {
      res.json(withFacts(JSON.parse(readFileSync(file, "utf-8")) as RunResult));
      return;
    }
    res.status(404).json({ error: "unknown run" });
  });

  /** World Model context for one claim of a run: its sections verbatim, definitions, prior verdicts. */
  router.get("/runs/:id/claims/:claimId/context", (req: Request, res: Response) => {
    const run = store.get(String(req.params.id));
    if (!run?.result) {
      res.status(404).json({ error: "unknown or unfinished run" });
      return;
    }
    const ctx = getEngines().world.context.buildForClaim(run.result.world_run_id ?? run.id, String(req.params.claimId));
    res.status(ctx.claim ? 200 : 404).json(ctx);
  });

  router.get("/acts", (_req, res) => {
    res.json(JSON.parse(readFileSync(actsFile(), "utf-8")));
  });

  router.get("/sections/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    // a Schedule item of the levies Act: its place in the Schedule, the Part's heading and the item's text
    const item = isItemId(id) ? levies().get(id) : undefined;
    if (item) {
      res.json({
        section_id: item.item_id,
        act_id: item.act_id,
        kind: "schedule_item",
        label: itemLabel(item.item_id),
        part: item.part,
        part_title: item.part_title,
        item_no: item.item_no,
        text: item.text,
      });
      return;
    }
    const s = SECTION_ID_RE.test(id) ? corpus().get(id) : undefined;
    if (!s) {
      res.status(404).json({ error: "unknown section" });
      return;
    }
    res.json({ section_id: s.section_id, act_id: s.act_id, section_no: s.section_no, heading: s.heading, text: s.text, chapter: s.chapter, part: s.part });
  });

  return router;
}
