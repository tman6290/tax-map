import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerAction, LedgerEntry } from "./types.js";

export interface LedgerQuery {
  memoryId?: string;
  action?: LedgerAction;
  runId?: string;
}

/**
 * TrustLedgerService (H-MEM spec §11.1): an append-only JSONL audit of every significant memory action.
 * Entries are only ever appended; queries and exports read the file back.
 */
export class TrustLedgerService {
  constructor(readonly file: string) {}

  append(entry: Omit<LedgerEntry, "timestamp"> & { timestamp?: string }): LedgerEntry {
    const full: LedgerEntry = { ...entry, timestamp: entry.timestamp ?? new Date().toISOString() };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(full)}\n`, "utf-8");
    return full;
  }

  entries(): LedgerEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as LedgerEntry);
  }

  query(q: LedgerQuery = {}): LedgerEntry[] {
    return this.entries().filter(
      (e) =>
        (q.memoryId === undefined || e.memoryId === q.memoryId) &&
        (q.action === undefined || e.action === q.action) &&
        (q.runId === undefined || e.runId === q.runId),
    );
  }

  /** The matching entries as JSONL, for shipping as evidence. */
  export(q: LedgerQuery = {}): string {
    return this.query(q)
      .map((e) => JSON.stringify(e))
      .join("\n");
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries()) out[e.action] = (out[e.action] ?? 0) + 1;
    return out;
  }
}
