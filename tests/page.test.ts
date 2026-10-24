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
    expect(t).toContain("Tell Tax Map about your business. It reads Nigeria's 2025 tax laws, lists what you owe and what you're exempt from, and shows you the exact section behind every line. Built for Lagos businesses.");
    expect(t).toContain("Your business");
    expect(t).toContain("Fill in your business details.");
    expect(t).not.toContain("Lagos only for now"); // the State field stays fixed at Lagos without a hint
    expect(html).toContain('id="state" name="state" type="text" value="Lagos" readonly />');
    expect(t).not.toContain("Example values");
    expect(t).toContain("Reads the law All four of Nigeria's 2025 federal tax Acts, section by section.");
    expect(t).toContain("Finds what applies to you The Researcher reads the relevant sections in full before citing them.");
    expect(t).toContain("Checks every line The Critic compares each claim with the quoted text and rejects anything the law doesn't support.");
    expect(t).not.toMatch(/\bagent\b/i); // one actor vocabulary: the Researcher and the Critic
    expect(t).toContain("You can open the working behind any answer.");
  });

  it("has the new footer", () => {
    expect(text(html)).toContain("Answers cite Nigeria's 2025 federal tax Acts. Lagos State and local government levies are being added. This is not legal advice.");
    expect(text(html)).not.toContain("not yet loaded");
  });

  it("puts one collapsed disclosure at the very bottom of the results, after unanswered and notes", () => {
    expect(html).not.toContain("Show working");
    const disclosures = html.match(/<details class="working"[^>]*>/g) ?? [];
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).not.toContain(" open"); // collapsed
    const at = (needle: string) => html.indexOf(needle);
    expect(at('id="claims"')).toBeLessThan(at('id="unanswered-block"'));
    expect(at('id="unanswered-block"')).toBeLessThan(at('id="notes-block"'));
    expect(at('id="notes-block"')).toBeLessThan(at('<details class="working"'));
    // after the disclosure: only the end of the results section and the page footer
    const after = html.slice(at("</details>", at('<details class="working"')) + "</details>".length);
    expect(text(after.slice(0, after.indexOf("</main>")))).toBe(" ");
    const working = /<details class="working"[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
    expect(text(working)).toContain("See how this answer was produced");
    expect(text(working)).toContain("Tax Map runs on NVIDIA Nemotron models through Meterless Nightshift; the statutes are served by Zetaris. Every model call carries a signed receipt.");
    for (const part of ["Run log", "Memory", "Queries the Researcher ran", "Sections read in full", "Definitions attached", "Model calls"]) expect(text(working), part).toContain(part);
    // the first line inside it is the sentence about the models
    expect(/<div class="working-body">\s*<p class="working-intro">/.test(working)).toBe(true);
  });

  it("names the sponsors and models only inside the disclosure", () => {
    expect(SPONSOR.test(text(beforeWorking))).toBe(false);
    expect(SPONSOR.test(beforeWorking)).toBe(false); // attributes and the meta description too
    const working = /<details class="working"[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
    expect(SPONSOR.test(text(working))).toBe(true);
  });

  it("uses plain-word verdict labels, 'Why' and 'Open the law' on result cards", () => {
    for (const label of ["Applies to you", "Applies with a condition", "Rejected by the check", "Not verified"]) expect(js).toContain(`"${label}"`);
    expect(js).toContain('"Why"');
    expect(js).toContain("Open the law");
    expect(js).not.toContain("Critic's reason");
    expect(js).not.toMatch(/text: "(?:Supported|Qualified|Struck)"/);
  });

  it("explains the labels once, in a panel, and keeps markers off the summary and the chips", () => {
    expect(html).toContain("What do these labels mean?");
    expect(html).toContain('id="labels-panel"');
    expect(js).toContain("fillLabelsPanel");
    for (const k of ["supported", "qualified", "struck", "unchecked", "obligation", "exemption"]) expect(js, k).toContain(`"${k}"`);
    expect(js).not.toContain("helpButton([v])");
    expect(js).not.toContain("helpButton([kind])");
    expect(js).not.toMatch(/annotated\([^;]*"summary"/); // the summary line is plain text
    for (const [k, e] of Object.entries(help.terms)) if (["supported", "qualified", "struck", "unchecked", "obligation", "exemption"].includes(k)) expect(e.annotate, k).toBeUndefined();
    expect(js).toContain("markedTerms"); // a claim-text term is marked once per page
  });

  it("marks help buttons at 0.9em on the text baseline", () => {
    const css = read("styles.css");
    const btn = /\.help-btn \{[\s\S]*?\}/.exec(css)?.[0] ?? "";
    const circle = /\.help-btn \.q \{[\s\S]*?\}/.exec(css)?.[0] ?? "";
    expect(circle).toMatch(/width: 0\.9em/);
    expect(circle).toMatch(/height: 0\.9em/);
    expect(btn).toMatch(/vertical-align: baseline/);
    expect(btn).toMatch(/overflow: hidden/); // makes the button's bottom edge its baseline
    expect(btn).not.toMatch(/vertical-align: (?:middle|top|bottom|-?\d)/);
    expect(css).not.toMatch(/\.help \{[^}]*(?:top|vertical-align: middle)/);
  });

  it("shows a struck claim in full legibility: no strikethrough, red chip and border, faint red tint, reason open", () => {
    const css = read("styles.css");
    expect(css).not.toContain("line-through");
    expect(css).toMatch(/\.claim\.v-struck \{[^}]*border-left-color: var\(--v-struck\)[^}]*background: #fdf4f5/);
    expect(css).toMatch(/\.chip\.v-struck \{[^}]*background: var\(--v-struck\)/);
    expect(js).toContain("more.open = v === \"struck\"");
  });

  it("lists at most four defined terms per card, claim terms first, under 'Defined in the law'", () => {
    expect(js).toContain('"Defined in the law"');
    expect(js).toContain(".slice(0, 4)");
    expect(js).toContain("filter(inClaim), ...defs.filter((d) => !inClaim(d))");
  });

  it("gives the progress list a fixed-width number column, so two-digit steps never clip", () => {
    const css = read("styles.css");
    expect(html).toMatch(/<ol id="progress-list" class="log-list"/);
    expect(css).toMatch(/\.log-list li \{[^}]*grid-template-columns: 3ch minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.log-list li::before \{[^}]*content: counter\(step\)/);
    expect(js).toContain("ev.detail || ev.text"); // the technical line goes to the run log
  });

  it("keeps to the type scale: one serif for headings, one sans for body, nothing under 15 px but the receipts table", () => {
    const css = read("styles.css");
    const sizes = [...css.matchAll(/--t-[a-z]+: ([\d.]+)rem/g)].map((m) => Math.round(Number(m[1]) * 16));
    expect(sizes).toEqual([15, 17, 20, 26, 34, 13]);
    // every font size names a scale token; the marker's "?" glyph is the one relative size
    const literal = [...css.matchAll(/font(?:-size)?:[^;]*?(\d*\.?\d+)(px|rem)\b/g)].map((m) => m[0]);
    expect(literal).toEqual([]);
    expect(css).toMatch(/body \{[^}]*font: var\(--t-base\) \/ 1\.5 var\(--sans\)/);
    expect(css).toMatch(/h3 \{[^}]*font-family: var\(--serif\);[^}]*line-height: 1\.2/);
    expect(css).toMatch(/table \{[^}]*font-size: var\(--t-table\)/);
    expect(css).toMatch(/--measure: 68ch/);
  });

  it("uses an 8 px rhythm with 24 px between cards, 20 px inside them and 6 px from label to control", () => {
    const css = read("styles.css");
    expect(css).toMatch(/--card-pad: 20px/);
    expect(css).toMatch(/--label-gap: 6px/);
    expect(css).toMatch(/\.claims \{[^}]*gap: var\(--s3\)/);
    expect(css).toMatch(/--s3: 24px/);
    const px = [...css.matchAll(/(?:margin|padding|gap)[a-z-]*: ([^;]+);/g)].flatMap((m) => [...(m[1] ?? "").matchAll(/(-?\d+)px/g)].map((x) => Math.abs(Number(x[1]))));
    // 4 px half-steps, the 20 px card padding, 6 px label gap; 9/11/12/15 px make 44 px controls and hit areas
    for (const n of px) expect([0, 2, 3, 4, 6, 8, 9, 11, 12, 15, 16, 20, 24, 32, 48], String(n)).toContain(n);
  });

  it("uses one green for interactive elements and the four verdict colours for chips", () => {
    const css = read("styles.css");
    const chipBackgrounds = [...css.matchAll(/\.chip\.v-\w+ \{[^}]*background: var\((--[\w-]+)\)/g)].map((m) => m[1]);
    expect(chipBackgrounds).toEqual(["--v-supported", "--v-qualified", "--v-struck", "--v-unchecked"]);
    expect(css).toMatch(/a,\s*\.link-button \{\s*color: var\(--action\)/);
    expect(css).toMatch(/\.button \{[^}]*background: var\(--action\)/);
    expect(css).toMatch(/:focus-visible \{\s*outline: 3px solid var\(--focus\)/);
  });

  it("guards the Run button during a run and shows a plain error when a run fails", () => {
    expect(js).toContain("if (running) return");
    expect(js).toContain('runButton.setAttribute("aria-busy", "true")');
    expect(js).toContain('"Something went wrong on our side. Try again in a minute."');
    expect(html).toContain("Something went wrong on our side. Try again in a minute.");
    expect(html).toMatch(/<section class="wsec" id="error-block" hidden>/); // the technical detail sits in the disclosure
    expect(read("styles.css")).toMatch(/\.button\[aria-busy="true"\]::before/);
  });

  it("shows an example line before the first run", () => {
    const how = /<section id="how"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(how).toContain('class="claim v-supported example-card"');
    expect(text(how)).toContain("Applies to you Obligation Nigeria Tax Administration Act 2025, s. 4");
  });

  it("holds space for the summary and keeps it in place while the run works", () => {
    expect(read("styles.css")).toMatch(/\.summary \{[^}]*min-height: 1\.2em/);
    expect(html.indexOf('id="summary"')).toBeLessThan(html.indexOf('id="progress"'));
    expect(js).toContain('summary.textContent = "Working on your answer…"');
  });

  it("opens the law in a drawer with the Act, section number and heading; Escape, backdrop and focus are handled", () => {
    expect(html).toContain('id="drawer-act"');
    expect(js).toContain("`Section ${s.section_no ?? no}: ${s.heading}`");
    expect(js).toContain("function holdFocus(dialog)");
    expect(js).toContain('if (e.key !== "Tab") return;');
    expect(js).toContain("holdFocus($(\"drawer\"))");
    expect(js).toContain("dialog.showModal()"); // a modal dialog closes on Escape natively
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
