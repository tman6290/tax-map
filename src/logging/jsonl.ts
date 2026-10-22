import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Append one JSON object as a single line, creating the directory if needed. */
export async function appendJsonl(file: string, obj: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(obj)}\n`, "utf-8");
}
