// Stable content-hash ids and order-independent JSON, so repeated ingests of the same run converge.
import { createHash } from "node:crypto";
import type { EdgeType } from "./types.js";

const h = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/**
 * Stable content-hash ids (World Model spec §15.4): the same thing always gets the same id, so
 * agents and repeated ingests converge without coordination.
 */
export const ids = {
  act: (actId: string) => `act_${h(`act|${actId}`)}`,
  section: (sectionId: string) => `section_${h(`section|${sectionId}`)}`,
  definition: (sectionId: string, term: string) => `definition_${h(`definition|${sectionId}|${term.toLowerCase()}`)}`,
  /** Claim ids are per run: the same wording in another run is another claim. */
  claim: (runId: string, claimId: string) => `claim_${h(`claim|${runId}|${claimId}`)}`,
  verdict: (runId: string, claimId: string) => `verdict_${h(`verdict|${runId}|${claimId}`)}`,
  run: (runId: string) => `run_${h(`run|${runId}`)}`,
  edge: (type: EdgeType, from: string, to: string) => `edge_${h(`${type}|${from}|${to}`)}`,
};

/** Order-independent JSON for hashing and change detection. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const contentHash = (v: unknown) => h(stableStringify(v));
