import { randomUUID } from "node:crypto";

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
}

export interface RunSqlOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}

export interface Section {
  section_id: string;
  act_id: string;
  act_title: string;
  section_no: string;
  heading: string | null;
  text: string;
  chapter: string | null;
  part: string | null;
  tier: string;
  source_file: string;
  source_sha256: string;
  page_start: number;
  page_end: number;
}

/** Error from the Zetaris API. `status` is set for HTTP failures; the message never contains credentials. */
export class ZetarisError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ZetarisError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 500;

function config(): { url: string; key: string; orgId: string } {
  const url = process.env.ZETARIS_REST_URL?.replace(/\/$/, "");
  const key = process.env.ZETARIS_API_KEY;
  const orgId = process.env.ZETARIS_ORG_ID;
  if (!url || !key || !orgId) {
    throw new ZetarisError("ZETARIS_REST_URL, ZETARIS_API_KEY and ZETARIS_ORG_ID must be set in .env");
  }
  return { url, key, orgId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Zetaris answers `{headers: string[], data: unknown[][]}`. */
function parseResponse(body: unknown): SqlResult {
  const b = body as { headers?: unknown; data?: unknown } | null;
  if (!b || !Array.isArray(b.headers) || !Array.isArray(b.data)) {
    throw new ZetarisError("Unexpected response shape from Zetaris (expected headers and data arrays)");
  }
  return { columns: b.headers.map(String), rows: b.data as unknown[][] };
}

/**
 * Run one SQL statement through the SQL editor endpoint.
 * 30 s timeout per attempt; up to 2 retries with exponential backoff on network errors
 * (including timeouts) and 5xx responses. 4xx responses are never retried.
 */
export async function runSql(sql: string, options: RunSqlOptions = {}): Promise<SqlResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, backoffMs = DEFAULT_BACKOFF_MS } = options;
  const { url, key, orgId } = config();
  let lastError: ZetarisError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetch(`${url}/sql-editor/sqls/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "X-Org-ID": orgId,
          "X-Request-ID": randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 1000 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      lastError = new ZetarisError(
        timedOut ? `Zetaris request timed out after ${timeoutMs} ms` : "Cannot reach Zetaris (network error)",
      );
      continue;
    }

    if (res.status >= 500) {
      lastError = new ZetarisError(`Zetaris server error: HTTP ${res.status}`, res.status);
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      throw new ZetarisError(`Zetaris rejected the request: HTTP ${res.status} ${detail}`.trim(), res.status);
    }
    return parseResponse(await res.json());
  }
  throw lastError ?? new ZetarisError("Zetaris request failed");
}

function toSection(columns: string[], row: unknown[]): Section {
  const rec: Record<string, unknown> = {};
  columns.forEach((c, i) => {
    rec[c] = row[i] ?? null;
  });
  return {
    ...(rec as unknown as Section),
    page_start: Number(rec.page_start),
    page_end: Number(rec.page_end),
  };
}

/**
 * Select rows from taxmap.sections. `whereClause` is SQL text supplied by trusted code
 * (never user input); statement separators are rejected. Pass "1=1" for no filter.
 */
export async function querySections(whereClause: string, limit: number): Promise<Section[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("limit must be an integer between 1 and 1000");
  }
  if (whereClause.includes(";")) throw new RangeError("whereClause must not contain ';'");
  const { columns, rows } = await runSql(`SELECT * FROM taxmap.sections WHERE ${whereClause} LIMIT ${limit}`);
  return rows.map((r) => toSection(columns, r));
}
