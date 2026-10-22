import "dotenv/config";
import { pathToFileURL } from "node:url";
import express from "express";

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
}
