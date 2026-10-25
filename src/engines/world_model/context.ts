// World Model context builder: for one claim, the verbatim text of its sections, the definitions it
// used and earlier verdicts on the same sections.
import { ids } from "./ids.js";
import type { WorldStoreService } from "./store.js";

export const CONTEXT_SCHEMA = "wm.claim_context.v1";

export interface ClaimContext {
  schema: typeof CONTEXT_SCHEMA;
  claim: { runId: string; claimId: string; text: string; type: string; verdict: string | null } | null;
  sections: Array<{ section_id: string; heading: string; text: string; mentionCount: number }>;
  definitions: Array<{ section_id: string; term: string; definition: string }>;
  priorVerdicts: Array<{ runId: string; claimId: string; claimText: string; section_id: string; verdict: string; quote: string | null; reason: string }>;
  trace: {
    strategy: "claim_focused";
    selectionReason: string;
    joined: string[];
    budget: { maxSections: number; maxPriorVerdicts: number; truncated: boolean };
  };
  /** Which context builders are live and which are not (the World Model spec's wired-vs-helper map). */
  manifest: { wired: string[]; dormant: string[] };
}

const MAX_SECTIONS = 10;
const MAX_PRIOR = 20;

/**
 * ContextBuilderService (World Model spec §10.2): for a claim, the verbatim text of its sections, the
 * definitions it used, and earlier runs' verdicts on the same sections, as a structured payload with a
 * trace of every join. Consumers format it themselves.
 */
export class ContextBuilderService {
  constructor(private readonly store: WorldStoreService) {}

  buildForClaim(runId: string, claimId: string): ClaimContext {
    const s = this.store;
    const joined: string[] = [];
    const claimEntity = s.entity(ids.claim(runId, claimId));
    const verdict = s.entity(ids.verdict(runId, claimId));
    joined.push(`claim ${claimId} of run ${runId}: ${claimEntity ? "found" : "not found"}`);

    const cited = claimEntity ? s.neighbors(claimEntity.id, { type: "cites", direction: "out" }).map((n) => n.entity) : [];
    joined.push(`cites -> ${cited.length} sections`);
    const defs = claimEntity ? s.neighbors(claimEntity.id, { type: "uses_definition", direction: "out" }).map((n) => n.entity) : [];
    joined.push(`uses_definition -> ${defs.length} definitions`);

    const prior: ClaimContext["priorVerdicts"] = [];
    for (const sec of cited) {
      // other claims citing this section, from other runs, and their verdicts
      for (const { entity: other } of s.neighbors(sec.id, { type: "cites", direction: "in" })) {
        if (other.provenance.runId === runId) continue;
        for (const { entity: v } of s.neighbors(other.id, { type: "judges", direction: "in" })) {
          prior.push({
            runId: v.provenance.runId,
            claimId: String(other.properties.claim_id ?? other.name),
            claimText: String(other.properties.text ?? ""),
            section_id: String(sec.properties.section_id),
            verdict: String(v.properties.verdict),
            quote: (v.properties.quote as string | null) ?? null,
            reason: String(v.properties.reason ?? ""),
          });
        }
      }
    }
    // most recent runs first
    prior.sort((a, b) => b.runId.localeCompare(a.runId));
    joined.push(`section <- cites <- claims of other runs <- judges: ${prior.length} prior verdicts`);

    const sections = cited
      .sort((a, b) => b.aggregates.mentionCount - a.aggregates.mentionCount)
      .map((e) => ({
        section_id: String(e.properties.section_id),
        heading: String(e.properties.heading ?? ""),
        text: String(e.properties.text ?? ""),
        mentionCount: e.aggregates.mentionCount,
      }));
    return {
      schema: CONTEXT_SCHEMA,
      claim: claimEntity
        ? {
            runId,
            claimId,
            text: String(claimEntity.properties.text ?? ""),
            type: String(claimEntity.properties.type ?? "obligation"),
            verdict: verdict ? String(verdict.properties.verdict) : null,
          }
        : null,
      sections: sections.slice(0, MAX_SECTIONS),
      definitions: defs.map((d) => ({
        section_id: String(d.properties.section_id),
        term: String(d.properties.term ?? d.name),
        definition: String(d.properties.definition ?? ""),
      })),
      priorVerdicts: prior.slice(0, MAX_PRIOR),
      trace: {
        strategy: "claim_focused",
        selectionReason: "sections the claim cites (most-cited first), the definitions it used, and verdicts other runs gave on claims citing the same sections (newest first)",
        joined,
        budget: { maxSections: MAX_SECTIONS, maxPriorVerdicts: MAX_PRIOR, truncated: sections.length > MAX_SECTIONS || prior.length > MAX_PRIOR },
      },
      manifest: {
        wired: ["buildForClaim: GET /api/runs/:id/claims/:claimId/context", "getFacts: GET /api/runs/:id (verified_facts)"],
        dormant: ["buildForClaim is not yet fed into the Critic's prompt; the Critic reads the cited text directly"],
      },
    };
  }
}
