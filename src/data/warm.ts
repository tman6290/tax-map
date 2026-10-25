import { runSql } from "./zetaris.js";

/** Views cached in Zetaris. Their REST tables re-fetch and re-parse the JSON on every uncached query (40-60 s). */
export const CACHED_VIEWS = ["taxmap.sections", "taxmap.acts", "taxmap.levies"];
const CACHE_TIMEOUT_MS = 180_000; // one cold fetch and parse took about 60 s

export interface WarmResult {
  view: string;
  ms: number;
}

/**
 * CACHE TABLE on the statute views. The Zetaris cache does not survive a container restart (and
 * replacing a view drops its cache), so this runs on server start and before each pipeline run.
 */
export async function warmCache(): Promise<WarmResult[]> {
  const out: WarmResult[] = [];
  for (const view of CACHED_VIEWS) {
    const t = Date.now();
    await runSql(`CACHE TABLE ${view}`, { timeoutMs: CACHE_TIMEOUT_MS, retries: 1 });
    out.push({ view, ms: Date.now() - t });
  }
  return out;
}
