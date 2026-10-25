import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Schedule of the Taxes and Levies (Approved List for Collection) Act 1998 (data/statutes/levies.json):
 * one record per listed item. Section 1(1) makes the Federal Government, the State Government and the
 * local government responsible for collecting what Part I, Part II and Part III list. The item text is
 * verbatim, figures included; Tax Map never asserts those figures (see statesAmount).
 */
export const LEVIES_ACT = "TLA-1998";
export type LevyPart = "I" | "II" | "III";
export type LevyTier = "federal" | "state" | "lga";

export interface LevyItem {
  item_id: string;
  act_id: string;
  part: LevyPart;
  /** The Schedule's own heading for the Part, e.g. "Taxes and levies to be collected by the local government". */
  part_title: string;
  tier: LevyTier;
  item_no: string;
  text: string;
  source_file: string;
  source_sha256: string;
  page: number;
}

export const ITEM_ID_RE = /^TLA-1998-sch-(I|II|III)-(\d+)$/;
export const PART_TIER: Record<LevyPart, LevyTier> = { I: "federal", II: "state", III: "lga" };
export const TIER_PART: Record<LevyTier, LevyPart> = { federal: "I", state: "II", lga: "III" };

export const isItemId = (id: string) => ITEM_ID_RE.test(id);

/** The Schedule Part an item_id names, or null for any other id. */
export function itemPart(id: string): LevyPart | null {
  return (ITEM_ID_RE.exec(id)?.[1] as LevyPart | undefined) ?? null;
}

/** "Schedule, Part III, item 20" */
export function itemLabel(id: string): string {
  const m = ITEM_ID_RE.exec(id);
  return m ? `Schedule, Part ${m[1]}, item ${m[2]}` : id;
}

/** The heading the Researcher and the Critic see for an item: its place in the Schedule and the Part's own heading. */
export function itemHeading(item: Pick<LevyItem, "item_id" | "part_title">): string {
  return `${itemLabel(item.item_id)} (${item.part_title})`;
}

/** True when the id is a section or Schedule item of the Taxes and Levies (Approved List for Collection) Act. */
export const citesLeviesAct = (id: string) => id.startsWith(`${LEVIES_ACT}-`);

/**
 * A naira figure: "N10,000", "₦ 5,000", "NGN 100", "100 naira", "one hundred naira", or a grouped
 * number such as "10,000". Section numbers ("s. 3"), item numbers ("item 20") and years ("1998") are
 * not amounts.
 */
const AMOUNT_RE =
  /(?:₦|\bNGN|\bN)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|million|thousand))?\b|\b\d[\d,]*(?:\.\d+)?\s*(?:naira|kobo)\b|\b(?:hundred|thousand|million)\s+naira\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/i;

/** True when the sentence states an amount of money. */
export const statesAmount = (text: string) => AMOUNT_RE.test(text);

let cache: Map<string, LevyItem> | undefined;

/** data/statutes/levies.json, read once, keyed by item_id. */
export function levies(): Map<string, LevyItem> {
  if (cache) return cache;
  const candidates = [
    fileURLToPath(new URL("../../data/statutes/levies.json", import.meta.url)),
    resolve(process.cwd(), "data/statutes/levies.json"),
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) throw new Error("data/statutes/levies.json not found; run scripts/parse_acts.py");
  const rows = JSON.parse(readFileSync(file, "utf-8")) as LevyItem[];
  cache = new Map(rows.map((r) => [r.item_id, r]));
  return cache;
}
