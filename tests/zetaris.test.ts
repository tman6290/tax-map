import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { querySections, runSql, ZetarisError } from "../src/data/zetaris.js";

const FAST = { backoffMs: 1 };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  vi.stubEnv("ZETARIS_REST_URL", "http://zetaris.test/api/v1.0");
  vi.stubEnv("ZETARIS_API_KEY", "test-key");
  vi.stubEnv("ZETARIS_ORG_ID", "7");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("runSql", () => {
  it("parses headers and data into columns and rows, sending auth headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ headers: ["a", "b"], data: [["1", "x"]], total: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runSql("SELECT 1 AS a, 'x' AS b", FAST);

    expect(result).toEqual({ columns: ["a", "b"], rows: [["1", "x"]] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://zetaris.test/api/v1.0/sql-editor/sqls/run");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["X-Org-ID"]).toBe("7");
    expect(headers["X-Request-ID"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(init.body as string).sql).toBe("SELECT 1 AS a, 'x' AS b");
  });

  it("retries a 5xx and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(ok({ headers: ["n"], data: [["3"]] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runSql("SELECT 3", FAST);

    expect(result.rows).toEqual([["3"]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after 2 retries on persistent 5xx", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("down", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runSql("SELECT 1", FAST)).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad sql", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await runSql("SELEC", FAST).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ZetarisError);
    expect((err as ZetarisError).status).toBe(400);
    expect((err as ZetarisError).message).toContain("bad sql");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries network errors, and reports a timeout when every attempt hangs", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const fetchMock = vi.fn().mockImplementation(hang);
    vi.stubGlobal("fetch", fetchMock);

    await expect(runSql("SELECT 1", { timeoutMs: 20, backoffMs: 1 })).rejects.toThrow(/timed out after 20 ms/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never puts the API key in an error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const err = await runSql("SELECT 1", { ...FAST, retries: 0 }).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain("test-key");
  });
});

describe("querySections", () => {
  it("builds the query and maps rows to sections", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ok({
        headers: ["section_id", "heading", "page_start", "page_end"],
        data: [["NTA-2025-s9", "Substitution of dividend for total profit", "15", "15"]],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const rows = await querySections("act_id = 'NTA-2025'", 5);

    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string).sql).toBe(
      "SELECT * FROM taxmap.sections WHERE act_id = 'NTA-2025' LIMIT 5",
    );
    expect(rows[0]).toMatchObject({ section_id: "NTA-2025-s9", page_start: 15, page_end: 15 });
  });

  it("rejects statement separators and bad limits", async () => {
    await expect(querySections("1=1; DROP VIEW taxmap.sections", 5)).rejects.toThrow(RangeError);
    await expect(querySections("1=1", 0)).rejects.toThrow(RangeError);
  });
});
