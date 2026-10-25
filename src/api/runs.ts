// Runs in memory for the process lifetime, with their buffered events. A finished run is written to
// logs/runs before its result event is sent.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { NewRunEvent, RunEvent, RunMode, RunResult } from "./types.js";

export type RunStatus = "running" | "complete" | "failed";

export interface Run {
  id: string;
  mode: RunMode;
  status: RunStatus;
  started_at: string;
  events: RunEvent[];
  result?: RunResult;
  error?: string;
}

type Listener = (e: RunEvent) => void;

export function runsDir(): string {
  return resolve(process.env.RUNS_DIR ?? "logs/runs");
}

/**
 * Runs kept in memory for the process lifetime. Events are buffered, so a client that connects to
 * the event stream late still receives the whole run; completed runs are also written to logs/runs.
 */
export class RunStore {
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Map<string, Set<Listener>>();

  create(id: string, mode: RunMode): Run {
    const run: Run = { id, mode, status: "running", started_at: new Date().toISOString(), events: [] };
    this.runs.set(id, run);
    return run;
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  emit(run: Run, e: NewRunEvent): void {
    const event: RunEvent = { ...e, seq: run.events.length + 1 };
    run.events.push(event);
    for (const l of this.listeners.get(run.id) ?? []) l(event);
  }

  async complete(run: Run, result: RunResult): Promise<void> {
    run.result = result;
    run.status = "complete";
    // the directory is created first (logs/runs does not exist in a fresh clone), and the file is
    // written before the result is announced: the event stream ends with the result, so a caller that
    // reads it to the end may remove the directory (as the tests do) the moment it closes
    try {
      await mkdir(runsDir(), { recursive: true });
      await writeFile(join(runsDir(), `${run.id}.json`), JSON.stringify(result, null, 2), "utf-8");
    } catch (err) {
      console.error(`could not write run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.emit(run, { type: "result", ts: result.finished_at, agent: "system", text: "Run complete", data: result });
  }

  fail(run: Run, error: string): void {
    run.status = "failed";
    run.error = error;
    this.emit(run, {
      type: "failed",
      ts: new Date().toISOString(),
      agent: "system",
      text: "Something went wrong on our side. Try again in a minute.",
      detail: `Run failed: ${error}`,
      data: { error },
    });
  }

  /** Calls `listener` for every future event of the run; returns the unsubscribe function. */
  subscribe(id: string, listener: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(id, set);
    return () => set.delete(listener);
  }
}
