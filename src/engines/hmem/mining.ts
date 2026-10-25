// H-MEM mining without a model: runtime events become short memories, and model memory extractions are
// parsed defensively.
import type { MemoryType, NewMemory } from "./types.js";

/** The runtime events H-MEM mines (H-MEM spec §6), from the emitting agent's point of view. */
export type RuntimeEvent =
  | { kind: "tool_result"; agentId: string; runId: string; taskId?: string; tool: string; label: string; rowCount: number; sectionIds: string[]; headings?: string[]; payload?: unknown }
  | { kind: "handoff"; agentId: string; runId: string; taskId?: string; to: string; summary: string }
  | { kind: "node_complete"; agentId: string; runId: string; taskId?: string; node: string; summary: string }
  | { kind: "verdict"; agentId: string; runId: string; taskId?: string; claimId: string; claimText: string; verdict: string; sectionIds: string[]; quote: string | null; quoteVerified: boolean; reason: string }
  | { kind: "outcome"; agentId: string; runId: string; taskId?: string; success: boolean; summary: string };

const TYPE_BY_EVENT: Record<RuntimeEvent["kind"], MemoryType> = {
  tool_result: "factual",
  handoff: "general",
  node_complete: "procedural",
  verdict: "factual",
  outcome: "procedural",
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Robust parsing of a model's memory extraction (H-MEM spec §6): strips code fences, tolerates
 * text around the array, and keeps only non-empty strings. Returns [] when nothing parses.
 */
export function parseMemoryStrings(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => (typeof x === "string" ? x : typeof x === "object" && x && "content" in x ? String((x as { content: unknown }).content) : ""))
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * MemoryMiningService, no-model path (H-MEM spec §6): every runtime event becomes concise direct
 * summaries stored as short-term memories with event-derived type, tags, source and attribution.
 * An optional `extracted` model output is used when it parses; otherwise the fallback summary is.
 */
export function mineEvent(e: RuntimeEvent, extracted?: string | null): NewMemory[] {
  const base = { type: TYPE_BY_EVENT[e.kind], layer: "short_term" as const, agentId: e.agentId, runId: e.runId, taskId: e.taskId ?? null };
  const fromModel = parseMemoryStrings(extracted);
  const fallback = (content: string, extra: Partial<NewMemory>): NewMemory[] =>
    (fromModel.length ? fromModel : [content]).map((c) => ({ ...base, content: clip(c, 600), ...extra }) as NewMemory);

  switch (e.kind) {
    case "tool_result": {
      const list = e.sectionIds.slice(0, 12).map((id, i) => (e.headings?.[i] ? `${id} (${e.headings[i]})` : id));
      return fallback(`${e.tool} ${clip(e.label, 160)} returned ${e.rowCount} rows${list.length ? `: ${list.join("; ")}` : ""}`, {
        source: `tool:${e.tool}`,
        tags: ["tool_result", e.tool, ...e.sectionIds.slice(0, 12)],
        confidence: 0.7,
        payload: e.payload,
      });
    }
    case "handoff":
      return fallback(`${e.agentId} handed off to ${e.to}: ${e.summary}`, { source: `handoff:${e.agentId}->${e.to}`, tags: ["handoff", e.agentId, e.to], confidence: 0.6 });
    case "node_complete":
      return fallback(`${e.node} completed: ${e.summary}`, { source: `node:${e.node}`, tags: ["node_complete", e.node], confidence: 0.6 });
    case "verdict":
      return fallback(`Critic judged ${e.claimId} (${e.sectionIds.join(", ")}) ${e.verdict}: ${clip(e.claimText, 200)}${e.quote && e.quoteVerified ? ` | quote: "${clip(e.quote, 200)}"` : ""}`, {
        source: "critic:verdict",
        tags: ["verdict", e.verdict, ...e.sectionIds],
        confidence: e.quoteVerified ? 0.8 : 0.5,
      });
    case "outcome":
      return fallback(`Run outcome (${e.success ? "success" : "failure"}): ${e.summary}`, { source: "run:outcome", tags: ["outcome", e.success ? "success" : "failure"], confidence: 0.6 });
  }
}
