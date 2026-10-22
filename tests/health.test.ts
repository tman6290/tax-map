import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { app } from "../src/server.js";

let server: ReturnType<typeof app.listen>;
let base: string;

beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

it("GET /health returns {ok:true}", async () => {
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
