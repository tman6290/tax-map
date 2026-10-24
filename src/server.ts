import "dotenv/config";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { createApiRouter } from "./api/routes.js";
import { warmCache } from "./data/warm.js";

export const app = express();

app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", createApiRouter());

// the page: public/ beside src/ (or dist/)
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const sample = process.env.SAMPLE_MODE === "true";
  app.listen(port, "0.0.0.0", () => {
    console.log(`tax-map listening on 0.0.0.0:${port}${sample ? " (SAMPLE_MODE: runs replay data/samples, no model or Zetaris calls)" : ""}`);
  });
  if (!sample) {
    // The Zetaris cache does not survive a container restart: warm it in the background so /health
    // answers at once, and log rather than exit if Zetaris is not up yet.
    const t = Date.now();
    warmCache()
      .then((r) => console.log(`zetaris cache warmed in ${Date.now() - t} ms (${r.map((w) => `${w.view} ${w.ms} ms`).join(", ")})`))
      .catch((err: unknown) => console.error(`zetaris cache warm failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}
