import "dotenv/config";
import { pathToFileURL } from "node:url";
import express from "express";
import { warmCache } from "./data/warm.js";

export const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, "0.0.0.0", () => {
    console.log(`tax-map listening on 0.0.0.0:${port}`);
  });
  // The Zetaris cache does not survive a container restart: warm it in the background so /health
  // answers at once, and log rather than exit if Zetaris is not up yet.
  const t = Date.now();
  warmCache()
    .then((r) => console.log(`zetaris cache warmed in ${Date.now() - t} ms (${r.map((w) => `${w.view} ${w.ms} ms`).join(", ")})`))
    .catch((err: unknown) => console.error(`zetaris cache warm failed: ${err instanceof Error ? err.message : String(err)}`));
}
