// The Schedule of the Taxes and Levies (Approved List for Collection) Act 1998 and the rules on claims
// citing it: one claim per item, each naming a profile fact, at most six, and never an amount.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Claim, Profile } from "./types.js";

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

/** At most this many claims on Schedule items in an answer. */
export const MAX_LEVY_CLAIMS = 6;

/** Words that show a claim names a fact about a sector, besides the sector's own name. */
const SECTOR_WORDS: Record<string, string> = {
  retail: "retail|shop|kiosk|trad(?:e|er|ers|ing)|store",
  trading: "shop|kiosk|trad(?:e|er|ers|ing)|store",
  hospitality: "hospitality|hotel|restaurant|bar|lodging",
  drinks: "drinks?|beverage|liquor|bar",
};

/**
 * The profile facts a levy claim may name: premises and signage only when the profile has them, the
 * sector (by name and by the words that go with it), employees when there are any, and turnover.
 */
export function profileFactPattern(profile: Profile): RegExp {
  const parts = ["turnover"];
  if (profile.has_premises) parts.push("premises", "tenement", "building");
  if (profile.has_signage) parts.push("sign(?:s|age|boards?)?", "advertis[a-z]*");
  if (profile.employees > 0) parts.push("employ[a-z]*", "staff", "workers?");
  const sector = profile.sector.trim().toLowerCase();
  if (sector) {
    parts.push(...sector.split(/[^a-z]+/).filter((w) => w.length > 2));
    parts.push(...(SECTOR_WORDS[sector] ? [SECTOR_WORDS[sector]] : []));
  }
  return new RegExp(`(?<![a-z])(?:${parts.join("|")})(?![a-z])`, "i");
}

/** The Schedule items a claim cites. */
export const itemIdsOf = (claim: Pick<Claim, "section_ids">) => claim.section_ids.filter(isItemId);

export interface LevyLimit {
  claims: Claim[];
  /** One note per reason a claim was dropped, naming the claims; these start "Dropped claims" so the page files them under the working. */
  notes: string[];
}

/**
 * After the draft: claims that cite Schedule items are held to one claim per item (a claim whose sorted
 * citations repeat an earlier one's, or whose items are all claimed already, is dropped and the first
 * kept), must name a profile fact in their text, and are capped at `max` (the first ones kept).
 * Claims that cite no item are untouched. Every drop is recorded in the notes.
 */
export function limitLevyClaims(claims: Claim[], profile: Profile, max = MAX_LEVY_CLAIMS): LevyLimit {
  const fact = profileFactPattern(profile);
  const keys = new Set<string>();
  const claimed = new Set<string>();
  const dropped = { repeat: [] as string[], fact: [] as string[], cap: [] as string[] };
  let levyKept = 0;
  const kept = claims.filter((c) => {
    const items = itemIdsOf(c);
    if (!items.length) return true;
    const key = [...c.section_ids].sort().join(",");
    if (keys.has(key) || items.every((i) => claimed.has(i))) {
      dropped.repeat.push(c.id);
      return false;
    }
    if (!fact.test(c.text)) {
      dropped.fact.push(c.id);
      return false;
    }
    if (levyKept >= max) {
      dropped.cap.push(c.id);
      return false;
    }
    levyKept++;
    keys.add(key);
    items.forEach((i) => claimed.add(i));
    return true;
  });
  const notes = [
    dropped.repeat.length && `Dropped claims ${dropped.repeat.join(", ")}: they repeat an earlier levy claim on the same Schedule item.`,
    dropped.fact.length && `Dropped claims ${dropped.fact.join(", ")}: a levy claim must name a fact about the business (premises, signage, sector, employees or turnover) and these name none.`,
    dropped.cap.length && `Dropped claims ${dropped.cap.join(", ")}: an answer holds at most ${max} levy claims.`,
  ].filter((n): n is string => typeof n === "string");
  return { claims: kept, notes };
}
