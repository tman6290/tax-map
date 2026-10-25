import { itemPart, PART_TIER, type LevyPart } from "./levies.js";
import type { Claim, Profile } from "./types.js";

/**
 * Which authority collects the tax a claim is about. The Acts' own "tier" on a claim says which
 * instrument it cites; this says who collects, which can differ: the Nigeria Tax Administration Act
 * gives a State's tax authority the administration of income tax for resident individuals, and the
 * Nigeria Revenue Service everything else in the loaded Acts.
 */
export type CollectorTier = "federal" | "state" | "lga";

export interface Collector {
  tier: CollectorTier;
  authority: string;
  /** One or two sentences saying why, with the section; shown to the business owner. */
  basis: string;
  /** The section the basis rests on, for the page's "Open the section" link; null when the basis cites none. */
  section_id: string | null;
}

/**
 * The section the placement rests on: s. 3(1)(a) gives the Nigeria Revenue Service exclusive
 * responsibility for taxes on companies, VAT and the development levy; s. 3(2) makes the relevant tax
 * authority of a State responsible for taxes on resident individuals. (The definition of "relevant tax
 * authority" in s. 147 only lists the authorities, so it cannot be the basis.)
 */
export const COLLECTOR_SECTION = "NTAA-2025-s3";

export const NRS = "Nigeria Revenue Service";
export const stateAuthority = (state: string) => `${state} State Internal Revenue Service`;
export const lgaAuthority = (lga: string) => `${lga} Local Government`;

/** Taxes the Nigeria Revenue Service administers exclusively: VAT, the development levy, tax on companies, non-residents. */
const FEDERAL_TOPICS = /\bvat\b|value added tax|development levy|compan(?:y|ies)'? income tax|tax on compan|surcharge|withholding|non-resident|petroleum/i;

/** Income tax and the compliance around it for an individual: PAYE, returns, registration, the tax ID and record-keeping. */
const INDIVIDUAL_TOPICS =
  /personal income tax|\bpaye\b|pay as you earn|emoluments|income tax|\bregist|tax id\b|tax identification|taxpayer identification|particulars|\breturns?\b|\brecords?\b|books? of account|bookkeeping/i;

const BASIS_FEDERAL_TOPIC =
  "Nigeria Tax Administration Act 2025, s. 3(1)(a): the Nigeria Revenue Service has exclusive responsibility for administering value added tax, the development levy, tax on companies and tax on non-resident persons.";
const BASIS_COMPANY =
  "Nigeria Tax Administration Act 2025, s. 3(1)(a): the Nigeria Revenue Service has exclusive responsibility for administering taxes on companies.";
const BASIS_DEFAULT = "No State or local rule applies to this line in the loaded Acts, so it is shown under the federal authority.";

/** s. 1(1) of the Taxes and Levies (Approved List for Collection) Act: who collects what each Schedule Part lists. */
export const SCHEDULE_COLLECTOR_SECTION = "TLA-1998-s1";
const TLA_CITE = "Taxes and Levies (Approved List for Collection) Act 1998, s. 1(1)";

function scheduleCollector(part: LevyPart, profile: Profile): Collector {
  const tier = PART_TIER[part];
  const [government, authority] =
    tier === "federal" ? ["Federal Government", NRS] : tier === "state" ? ["State Government", stateAuthority(profile.state)] : ["local government", lgaAuthority(profile.lga)];
  const basis =
    `${TLA_CITE}: the ${government} is responsible for collecting the taxes and levies listed in Part ${part} of the Schedule, ` +
    `and this line cites an item in Part ${part}, so it goes to the ${authority}.`;
  return { tier, authority, basis, section_id: SCHEDULE_COLLECTOR_SECTION };
}

function basisIndividual(profile: Profile): string {
  const who = profile.business_type === "partnership" ? "a partner" : "a sole proprietor";
  return (
    `Nigeria Tax Administration Act 2025, s. 3(2): the relevant tax authority of the State is responsible for administering taxes for resident individuals, ` +
    `including tax on income, profits or gains. As ${who} you are taxed as an individual, so this line goes to ${profile.state} State.`
  );
}

/**
 * The collecting authority for a claim, by these rules in order:
 *  0. a claim citing an item of the levies Schedule goes to the tier s. 1(1) gives that Part: Part I
 *     federal, Part II the State, Part III the local government (the first item cited decides);
 *  1. a claim citing a State or LGA instrument goes to that tier (none is loaded yet);
 *  2. VAT, the development levy, companies income tax and tax on non-residents: federal;
 *  3. anything for a company: federal;
 *  4. income tax, PAYE, returns and registration for a sole proprietor or partner: the State;
 *  5. otherwise federal.
 */
export function collectorFor(claim: Pick<Claim, "text" | "tier"> & Partial<Pick<Claim, "section_ids">>, profile: Profile): Collector {
  const part = (claim.section_ids ?? []).map(itemPart).find((p) => p !== null);
  if (part) return scheduleCollector(part, profile);
  if (claim.tier === "state") return { tier: "state", authority: stateAuthority(profile.state), basis: `This line cites a ${profile.state} State instrument.`, section_id: null };
  if (claim.tier === "lga") return { tier: "lga", authority: lgaAuthority(profile.lga), basis: `This line cites a ${profile.lga} local government instrument.`, section_id: null };
  if (FEDERAL_TOPICS.test(claim.text)) return { tier: "federal", authority: NRS, basis: BASIS_FEDERAL_TOPIC, section_id: COLLECTOR_SECTION };
  if (profile.business_type === "company") return { tier: "federal", authority: NRS, basis: BASIS_COMPANY, section_id: COLLECTOR_SECTION };
  if (INDIVIDUAL_TOPICS.test(claim.text)) return { tier: "state", authority: stateAuthority(profile.state), basis: basisIndividual(profile), section_id: COLLECTOR_SECTION };
  return { tier: "federal", authority: NRS, basis: BASIS_DEFAULT, section_id: null };
}
