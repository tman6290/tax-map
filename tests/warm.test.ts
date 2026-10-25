import { describe, expect, it, vi } from "vitest";
import { warmCache } from "../src/data/warm.js";
import { runSql } from "../src/data/zetaris.js";

vi.mock("../src/data/zetaris.js", () => ({ runSql: vi.fn().mockResolvedValue({ columns: [], rows: [] }) }));

describe("warmCache", () => {
  it("caches the three statute views with a long timeout and reports each duration", async () => {
    const r = await warmCache();
    expect(vi.mocked(runSql).mock.calls.map((c) => c[0])).toEqual(["CACHE TABLE taxmap.sections", "CACHE TABLE taxmap.acts", "CACHE TABLE taxmap.levies"]);
    expect(vi.mocked(runSql).mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 180_000 });
    expect(r.map((w) => w.view)).toEqual(["taxmap.sections", "taxmap.acts", "taxmap.levies"]);
    expect(r.every((w) => typeof w.ms === "number")).toBe(true);
  });
});
