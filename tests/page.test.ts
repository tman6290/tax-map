import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { corpus } from "../src/agents/glossary.js";

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf-8");
const html = read("index.html");
const js = read("app.js");
const help = JSON.parse(read("help.json")) as { terms: Record<string, { title: string; text: string; law?: string[]; match?: string[]; annotate?: string }> };

const SPONSOR = /meterless|nemotron|nvidia|nightshift|zetaris/i;
/** The page as a user sees it before pressing Show working: everything except the working section. */
const beforeWorking = html.replace(/<details class="working"[\s\S]*?<\/details>/, "").replace(/<script[\s\S]*?<\/script>/g, "");
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

describe("page copy", () => {
  it("has the new tagline, form hint and how-it-works steps", () => {
    const t = text(html);
    expect(t).toContain("Tell Tax Map about your business. It reads Nigeria's 2025 tax laws, lists what you owe and what you're exempt from, and shows you the exact section behind every line.");
    expect(t).toContain("Your business");
    expect(t).toContain("Fill in your business details. Lagos only for now.");
    expect(t).not.toContain("Example values");
    expect(t).toContain("Reads the law All four of Nigeria's 2025 federal tax Acts, section by section.");
    expect(t).toContain("Finds what applies to you An agent reads the relevant sections in full before citing them.");
    expect(t).toContain("Checks every line A second agent compares each claim with the quoted text and strikes anything the law doesn't support.");
    expect(t).toContain("You can open the working behind any answer.");
  });

  it("names the sponsors and models only inside Show working", () => {
    expect(SPONSOR.test(text(beforeWorking))).toBe(false);
    expect(SPONSOR.test(beforeWorking)).toBe(false); // attributes and the meta description too
    const working = /<details class="working"[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
    expect(text(working)).toContain("Tax Map runs on NVIDIA Nemotron models through Meterless Nightshift, with the statutes served by Zetaris. Every model call below carries a signed receipt.");
  });

  it("uses plain-word verdict labels, 'Why' and 'Open the law' on result cards", () => {
    for (const label of ["Applies to you", "Applies with a condition", "Rejected by the check", "Not verified"]) expect(js).toContain(`"${label}"`);
    expect(js).toContain('"Why"');
    expect(js).toContain("Open the law");
    expect(js).not.toContain("Critic's reason");
    expect(js).not.toMatch(/text: "(?:Supported|Qualified|Struck)"/);
  });

  it("hides machinery messages (model, gateway, HTTP) from the user-facing text", () => {
    expect(js).toMatch(/const INTERNAL = \/.*meterless.*zetaris.*http/i);
    expect(js).toContain("plain(t, STEP_FAILED)");
    expect(js).toContain("AGENT_NOTE"); // housekeeping notes move under Show working
  });
});

describe("help.json", () => {
  const required = [
    "sole_proprietor", "company", "partnership", "sector", "lga", "turnover", "fixed_assets", "employees", "premises", "signage",
    "obligation", "exemption", "struck", "unchecked", "vat", "paye", "tax_id", "personal_income_tax", "companies_income_tax",
    "development_levy", "small_business", "small_company", "books_of_account",
  ];

  it("covers every required term with a plain one-to-three sentence explanation", () => {
    for (const k of required) {
      const e = help.terms[k];
      expect(e, k).toBeDefined();
      expect(e!.title.length, k).toBeGreaterThan(2);
      const sentences = e!.text.split(/(?<=[.?!])\s+/).length;
      expect(sentences, k).toBeLessThanOrEqual(4);
    }
  });

  it("does not state thresholds, rates or amounts: where the law defines a term it points to the section", () => {
    for (const [k, e] of Object.entries(help.terms)) {
      expect(e.text, k).not.toMatch(/[₦%]|\bN\d|\d{2,}/);
    }
    for (const k of ["small_business", "small_company", "development_levy", "vat", "personal_income_tax", "companies_income_tax", "books_of_account", "paye", "tax_id"]) {
      expect(help.terms[k]!.text, k).toContain("open the section to read it");
      expect(help.terms[k]!.law?.length, k).toBeGreaterThan(0);
    }
  });

  it("points only at sections that exist, and every form term has a slot in the page", () => {
    for (const e of Object.values(help.terms)) for (const id of e.law ?? []) expect(corpus().has(id), id).toBe(true);
    const slots = [...html.matchAll(/data-help="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/));
    for (const k of ["sole_proprietor", "company", "partnership", "sector", "lga", "turnover", "fixed_assets", "employees", "premises", "signage"]) expect(slots, k).toContain(k);
  });

  it("is keyboard accessible: buttons described by their tip, opened on click, hover and focus", () => {
    expect(js).toContain('"aria-describedby": id');
    expect(js).toContain('role: "tooltip"');
    expect(js).toContain('addEventListener("mouseenter"');
    expect(js).toContain('addEventListener("focusin"');
    expect(js).toContain('e.key === "Escape"');
  });
});
