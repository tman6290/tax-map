/**
 * World Model records (Meterless World Model spec §4). Aggregate shape: a graph of typed entities
 * and typed, directed edges, with runs as first-class contexts.
 */
export const SCHEMA_VERSION = 1;

export type EntityType = "act" | "section" | "definition" | "claim" | "verdict" | "run";
export type EdgeType = "cites" | "uses_definition" | "judges" | "defines" | "produced" | "part_of";

export interface Provenance {
  source: string;
  runId: string;
  agentId: string;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Lifecycle {
  state: "active" | "orphan";
  confidence: number;
}

export interface Aggregates {
  mentionCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface WMEntity {
  id: string;
  type: EntityType;
  name: string;
  properties: Record<string, unknown>;
  provenance: Provenance;
  lifecycle: Lifecycle;
  aggregates: Aggregates;
}

export interface WMContext {
  id: string;
  kind: "run";
  name: string;
  properties: Record<string, unknown>;
  provenance: Provenance;
}

export interface WMEdge {
  id: string;
  type: EdgeType;
  from: string;
  to: string;
  directed: true;
  runId: string;
  properties: Record<string, unknown>;
}

export interface IngestRecord {
  inputHash: string;
  stages: string[];
  completedAt: string | null;
}

export interface WorldDoc {
  schemaVersion: number;
  entities: Record<string, WMEntity>;
  contexts: Record<string, WMContext>;
  edges: Record<string, WMEdge>;
  ingests: Record<string, IngestRecord>;
  /** Materialised views, rebuilt from the canonical records (never edited directly). */
  views: { factsBySection: Record<string, Array<{ runId: string; claimId: string; verdict: string }>> };
}
