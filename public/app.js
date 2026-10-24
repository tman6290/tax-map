// Tax Map page: profile form, live progress over server-sent events, results with citations.
// Plain DOM; every value from the server is set as text, never as HTML.

const AMAKA = {
  business_type: "sole_proprietor",
  sector: "retail",
  state: "Lagos",
  lga: "Ikeja",
  turnover_band: "under_25m",
  fixed_assets_band: "under_250m",
  employees: 3,
  has_premises: true,
  has_signage: true,
};
const DEFAULT_QUESTION = "What taxes and levies does my business have to pay?";

const $ = (id) => document.getElementById(id);
const form = $("profile-form");
const runButton = $("run-button");
const formError = $("form-error");
const progress = $("progress");
const progressList = $("progress-list");
const results = $("results");

let actTitles = {};
let source = null;
let running = false;
/** Every event's technical line, for the run log in the disclosure. */
let runLog = [];

/** Creates an element with optional class and text; children may be nodes or strings. */
function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

/* ------------------------------------------------------------------ plain-language guard */

const INTERNAL = /meterless|nemotron|nvidia|nightshift|zetaris|http \d{3}|empty_response|provider_error/i;

/**
 * Text shown above "See how this answer was produced" is for the business owner. Messages from the machinery (model,
 * gateway or database names, HTTP errors) are replaced with a plain line; the working section keeps
 * the technical detail.
 */
function plain(text, fallback) {
  return INTERNAL.test(text) ? fallback : text;
}
const STEP_FAILED = "One background step did not complete, so the answer was kept as it stood before that step.";
const RUN_FAILED = "Something went wrong on our side. Try again in a minute.";

/* ------------------------------------------------------------------ help tooltips */

let helpTerms = {};
let helpCount = 0;
let openHelp = null;

/** Opens a law section in the drawer from a help tip; defined below with the drawer code. */
let openSectionHandler = () => {};

function placeTip(tip) {
  tip.style.left = "0px";
  const r = tip.getBoundingClientRect();
  const margin = 8;
  if (r.right > window.innerWidth - margin) tip.style.left = `${window.innerWidth - margin - r.right}px`;
  else if (r.left < margin) tip.style.left = `${margin - r.left}px`;
}

function setHelp(wrap, open, pin) {
  const btn = wrap.querySelector(".help-btn");
  const tip = wrap.querySelector(".help-tip");
  if (open) {
    if (openHelp && openHelp !== wrap) setHelp(openHelp, false);
    tip.hidden = false;
    placeTip(tip);
    wrap.dataset.open = "1";
    openHelp = wrap;
    if (pin !== undefined) wrap.dataset.pinned = pin ? "1" : "";
  } else {
    tip.hidden = true;
    delete wrap.dataset.open;
    wrap.dataset.pinned = "";
    if (openHelp === wrap) openHelp = null;
  }
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

/**
 * A small circled "?" that explains one or more terms from help.json. It opens on click, on hover and
 * on keyboard focus; Escape closes it. The tip is described to assistive technology with
 * aria-describedby. Returns null when none of the keys is in the glossary.
 */
function helpButton(keys) {
  const entries = keys.map((k) => ({ key: k, ...helpTerms[k] })).filter((e) => e.title);
  if (!entries.length) return null;
  const id = `help-tip-${++helpCount}`;
  const wrap = el("span", { className: "help" });
  const btn = el(
    "button",
    {
      className: "help-btn",
      attrs: { type: "button", "aria-label": `What is ${entries.map((e) => e.title).join(", ")}?`, "aria-expanded": "false", "aria-describedby": id },
    },
    el("span", { className: "q", attrs: { "aria-hidden": "true" } }), // the "?" is drawn by CSS
  );
  const tip = el("span", { className: "help-tip", attrs: { id, role: "tooltip" } });
  tip.hidden = true;
  for (const e of entries) {
    const part = el("span", { className: "help-part" });
    if (entries.length > 1) part.append(el("strong", { text: `${e.title}: ` }));
    part.append(e.text);
    tip.append(part);
    for (const sid of e.law ?? []) {
      const open = el("button", { className: "link-button help-law", text: "Open the section", attrs: { type: "button" } });
      open.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setHelp(wrap, false);
        openSectionHandler(sid, e.term, btn);
      });
      part.append(" ", open);
    }
  }
  wrap.append(btn, tip);

  let leaveTimer = 0;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (wrap.dataset.pinned) setHelp(wrap, false);
    else setHelp(wrap, true, true);
  });
  wrap.addEventListener("mouseenter", () => {
    clearTimeout(leaveTimer);
    if (!wrap.dataset.open) setHelp(wrap, true);
  });
  wrap.addEventListener("mouseleave", () => {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      if (!wrap.dataset.pinned && !wrap.contains(document.activeElement)) setHelp(wrap, false);
    }, 150);
  });
  wrap.addEventListener("focusin", () => {
    if (!wrap.dataset.open) setHelp(wrap, true);
  });
  wrap.addEventListener("focusout", (ev) => {
    if (!wrap.contains(ev.relatedTarget)) setHelp(wrap, false);
  });
  return wrap;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openHelp) {
    const btn = openHelp.querySelector(".help-btn");
    setHelp(openHelp, false);
    btn.focus();
  }
});
document.addEventListener("click", (e) => {
  if (openHelp && !openHelp.contains(e.target)) setHelp(openHelp, false);
});

/** Replaces each `<span data-help="key [key ...]">` in the page with its help button. */
function attachHelpSlots(root = document) {
  for (const slot of root.querySelectorAll("[data-help]")) {
    const b = helpButton(slot.dataset.help.split(/\s+/));
    if (b) slot.replaceWith(b);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Terms already marked in this result: each term is marked once on the page, at its first mention. */
const markedTerms = new Set();

/**
 * Text with a help button after the first mention of each glossary term whose `annotate` is `scope`
 * ("text" for claim text), skipping terms already marked elsewhere on the page (`markedTerms`).
 * Longest phrases win; mentions don't overlap.
 */
function annotated(text, scope) {
  const hits = [];
  for (const [key, e] of Object.entries(helpTerms)) {
    if (e.annotate !== scope || markedTerms.has(key)) continue;
    const phrases = [...(e.match ?? [])].sort((a, b) => b.length - a.length);
    if (!phrases.length) continue;
    const re = new RegExp(`(?<![A-Za-z0-9])(?:${phrases.map(escapeRe).join("|")})(?![A-Za-z0-9])`, "i");
    const m = re.exec(text);
    if (m) hits.push({ key, start: m.index, end: m.index + m[0].length });
  }
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue; // overlaps an earlier, longer mention
    frag.append(text.slice(at, h.end));
    const b = helpButton([h.key]);
    if (b) frag.append(b);
    markedTerms.add(h.key);
    at = h.end;
  }
  frag.append(text.slice(at));
  return frag;
}

/* ------------------------------------------------------------------ form */

function fillForm(p, question) {
  for (const key of ["business_type", "sector", "lga", "turnover_band", "fixed_assets_band"]) form.elements[key].value = p[key];
  form.elements.employees.value = String(p.employees);
  form.elements.has_premises.value = p.has_premises ? "yes" : "no";
  form.elements.has_signage.value = p.has_signage ? "yes" : "no";
  form.elements.question.value = question;
}

function readForm() {
  const f = form.elements;
  const employees = Number(f.employees.value);
  const profile = {
    business_type: f.business_type.value,
    sector: f.sector.value.trim(),
    state: "Lagos",
    lga: f.lga.value.trim(),
    turnover_band: f.turnover_band.value,
    fixed_assets_band: f.fixed_assets_band.value,
    employees,
    has_premises: f.has_premises.value === "yes",
    has_signage: f.has_signage.value === "yes",
  };
  const problems = [];
  if (!profile.sector) problems.push("Enter the sector.");
  if (!profile.lga) problems.push("Enter the local government area.");
  if (!Number.isInteger(employees) || employees < 0) problems.push("Employees must be a whole number, 0 or more.");
  if (f.question.value.trim().length < 3) problems.push("Enter a question.");
  return { profile, question: f.question.value.trim(), problems };
}

/* ------------------------------------------------------------------ citations */

/** "Nigeria Tax Administration Act, 2025" -> "Nigeria Tax Administration Act 2025". */
function actName(actId) {
  return (actTitles[actId] ?? actId).replace(/,\s*(\d{4})$/, " $1");
}

function splitId(sectionId) {
  const m = /^(.*-\d{4})-s(\d+)$/.exec(sectionId);
  return m ? { act: m[1], no: m[2] } : { act: sectionId, no: "" };
}

/** "Nigeria Tax Administration Act 2025, s. 22; Nigeria Tax Act 2025, s. 147" */
function citation(sectionIds) {
  const byAct = new Map();
  for (const id of sectionIds) {
    const { act, no } = splitId(id);
    byAct.set(act, [...(byAct.get(act) ?? []), no]);
  }
  return [...byAct].map(([act, nos]) => `${actName(act)}, ${nos.map((n) => `s. ${n}`).join(", ")}`).join("; ");
}

const SMALL_WORDS = new Set(["of", "and", "the", "on", "or", "for", "in", "to", "a", "an", "by", "with", "from", "at"]);
const KEEP_CAPS = /^(?:VAT|PAYE|[IVXLC]+)$/;

/** "CHAPTER SIX – VALUE ADDED TAX" -> "Chapter Six – Value Added Tax" (the Acts set these headings in capitals). */
function headingCase(text) {
  if (text !== text.toUpperCase()) return text;
  return text
    .split(/(\s+)/)
    .map((w, i) => {
      if (/^\s+$/.test(w) || KEEP_CAPS.test(w)) return w;
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

/* ------------------------------------------------------------------ progress */

/** One plain line in the progress panel; events with no plain line add nothing. */
function addProgress(text, agent) {
  if (!text) return;
  const li = el("li", { className: `agent-${agent}`, text: plain(text, STEP_FAILED) });
  progressList.append(li);
  progressList.scrollTop = progressList.scrollHeight;
}

/** Keeps the event's technical line for the run log. */
function logEvent(ev) {
  const line = ev.detail || ev.text;
  if (line) runLog.push(line);
}

/* ------------------------------------------------------------------ results */

const VERDICT_LABEL = {
  supported: "Applies to you",
  qualified: "Applies with a condition",
  struck: "Rejected by the check",
  unchecked: "Not verified",
};

/**
 * The citation and the way into the law. One section: its citation, then "Open the law ›". Several:
 * "Open the law:" with each section's citation as its own link, so no citation is printed twice.
 */
function citationParts(sectionIds) {
  const mk = (id, label) => {
    const b = el("button", { className: "link-button", text: label, attrs: { type: "button", "aria-label": `Open ${citation([id])}` } });
    b.addEventListener("click", (e) => openSection(id, undefined, e.currentTarget));
    return b;
  };
  if (sectionIds.length === 1) {
    return [el("span", { className: "citation", text: citation(sectionIds) }), el("span", { className: "open-law" }, mk(sectionIds[0], "Open the law ›"))];
  }
  const links = el("span", { className: "open-law" }, "Open the law: ");
  sectionIds.forEach((id, i) => {
    if (i) links.append(" · ");
    links.append(mk(id, citation([id])));
  });
  return [links];
}

/** At most four defined terms for a card, the ones that appear in the claim text first. */
function definitionsFor(c) {
  const text = c.claim.text.toLowerCase();
  const inClaim = (d) => new RegExp(`(?<![a-z0-9])${escapeRe(d.term.toLowerCase())}(?![a-z0-9])`).test(text);
  const defs = c.definitions ?? [];
  return [...defs.filter(inClaim), ...defs.filter((d) => !inClaim(d))].slice(0, 4);
}

/** The Critic's merge reason in recorded runs ("no piece supports the claim") in the words it uses now. */
function plainReason(reason) {
  return /^no piece supports the claim$/i.test(reason ?? "") ? "None of the cited sections, read in full, supports this line." : plain(reason ?? "", STEP_FAILED);
}

function claimCard(c) {
  const v = c.verdict;
  const card = el("article", { className: `claim v-${v}` });

  // the claim text, then one row: verdict, type, citation, the way into the law.
  // The labels are explained once, in the panel behind "What do these labels mean?"
  const text = el("p", { className: "claim-text" });
  text.append(annotated(c.claim.text, "text"));
  const kind = c.claim.type === "exemption" ? "exemption" : "obligation";
  card.append(
    text,
    el(
      "div",
      { className: "claim-meta" },
      el("span", { className: `chip v-${v}`, text: VERDICT_LABEL[v] ?? v }),
      el("span", { className: "claim-type", text: kind === "exemption" ? "Exemption" : "Obligation" }),
      ...citationParts(c.claim.section_ids),
    ),
  );

  // the quote and the reasoning; a rejected line shows its reason up front, since the reason is the point
  const more = el("details", { className: "claim-more" }, el("summary", { text: v === "struck" ? "Hide the quote and why" : "Show the quote and why" }));
  more.open = v === "struck";
  more.addEventListener("toggle", () => {
    more.querySelector("summary").textContent = `${more.open ? "Hide" : "Show"} the quote and why`;
  });
  const body = el("div", { className: "claim-body" });
  body.append(el("h4", { text: "Quote from the law" }));
  if (c.quote && c.quote_verified) body.append(el("blockquote", { text: c.quote }));
  else body.append(el("p", { className: "unverified", text: c.quote ? "The quote could not be found in the cited text." : "No quote: the cited text does not establish this claim." }));

  body.append(el("h4", { text: "Why" }), el("p", { className: "reason", text: plainReason(c.reason) }));
  if (c.qualifier) body.append(el("h4", { text: "Condition" }), el("p", { className: "qualifier", text: c.qualifier }));

  const defs = definitionsFor(c);
  if (defs.length) {
    const ul = el("ul", { className: "plain-list compact" });
    for (const d of defs) ul.append(el("li", { text: `“${d.term}” (${citation([d.section_id])})` }));
    body.append(el("h4", { text: "Defined in the law" }), ul);
  }
  more.append(body);
  card.append(more);
  return card;
}

/** Housekeeping notes the agent writes about its own filtering: shown in the disclosure, not as advice. */
const AGENT_NOTE = /^(?:Removed \d+ note|Dropped (?:section_ids|claims)|Cited but not read|Coverage revision|Used the draft|Kept the draft|Model reply could not be parsed|Stopped after)/;

function fillList(listId, blockId, items) {
  const list = $(listId);
  list.replaceChildren(...items.map((t) => el("li", { text: plain(t, STEP_FAILED) })));
  $(blockId).hidden = items.length === 0;
}

/** The agent's checklist results ("Checklist (c) Employer obligations: no claim after a targeted search of ...") in plain words. */
const CHECKLIST_RE = /^Checklist \([a-f]\) (.+?): (?:no claim after a targeted search of .*|not searched in a targeted turn.*)$/;
function plainUnanswered(item) {
  const m = CHECKLIST_RE.exec(item);
  return m ? `${m[1]}: the check could not confirm this from the Acts.` : item;
}

function renderResult(r) {
  markedTerms.clear();
  const claims = r.checked ?? [];
  const ok = (c) => c.verdict === "supported" || c.verdict === "qualified";
  const n = {
    obligations: claims.filter((c) => ok(c) && c.claim.type !== "exemption").length,
    exemptions: claims.filter((c) => ok(c) && c.claim.type === "exemption").length,
    struck: claims.filter((c) => c.verdict === "struck").length,
    unchecked: claims.filter((c) => c.verdict === "unchecked").length,
  };
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const summary = $("summary");
  summary.classList.remove("pending");
  summary.textContent = `${plural(n.obligations, "obligation", "obligations")}, ${plural(n.exemptions, "exemption", "exemptions")}, ${n.struck} struck, ${n.unchecked} could not be verified`;
  const badge = $("sample-badge");
  badge.hidden = r.mode !== "sample";
  if (r.mode === "sample") badge.title = `Replay of the recorded run “${r.sample}”`;
  $("results-meta").classList.remove("waiting");

  $("claims").replaceChildren(...claims.map(claimCard));
  const unanswered = r.draft?.unanswered ?? [];
  fillList("unanswered", "unanswered-block", unanswered.map(plainUnanswered));
  const notes = r.draft?.notes ?? [];
  fillList("notes", "notes-block", notes.filter((n) => !AGENT_NOTE.test(n) && !INTERNAL.test(n)));
  const agentNotes = [...notes.filter((n) => AGENT_NOTE.test(n) || INTERNAL.test(n)), ...unanswered.filter((u) => CHECKLIST_RE.test(u))];
  $("agent-notes").replaceChildren(...agentNotes.map((t) => el("li", { text: t })));
  $("agent-notes-block").hidden = agentNotes.length === 0;

  // the disclosure stays technical
  $("queries").replaceChildren(
    ...(r.queries ?? []).map((q) =>
      el("li", {}, `${q.row_count} ${q.row_count === 1 ? "row" : "rows"}${q.error ? ` (rejected: ${q.error})` : ""}`, el("code", { className: "sql", text: q.sql })),
    ),
  );
  $("sections-read").replaceChildren(
    ...(r.sections_read ?? []).map((s) => {
      const b = el("button", { className: "link-button", text: s.section_id, attrs: { type: "button" } });
      b.addEventListener("click", (e) => openSection(s.section_id, undefined, e.currentTarget));
      return el("li", {}, b, s.heading ? ` ${s.heading}` : "");
    }),
  );
  $("definitions").replaceChildren(
    ...(r.definitions ?? []).flatMap((d) => [el("dt", { text: `${d.section_id}: “${d.term}”` }), el("dd", { text: d.definition })]),
  );
  $("receipts").tBodies[0].replaceChildren(
    ...(r.receipts ?? []).map((x) =>
      el(
        "tr",
        {},
        el("td", { className: "num", text: String(x.call) }),
        el("td", { text: x.agent.charAt(0).toUpperCase() + x.agent.slice(1) }),
        el("td", {}, el("code", { text: x.requested_model })),
        el("td", {}, el("code", { text: x.routed_model })),
        el("td", { text: [x.provider, x.label].filter(Boolean).join(" · ") }),
        el("td", { className: "num", text: `${x.input_tokens.toLocaleString()} / ${x.output_tokens.toLocaleString()}` }),
        el("td", { className: "num", text: `${(x.latency_ms / 1000).toFixed(1)} s` }),
        el("td", { text: x.signed ? "✓ signed" : "unsigned" }),
      ),
    ),
  );
  const m = r.memory;
  const w = r.world;
  $("memory-line").textContent =
    m && w
      ? `${m.retrieved_from_prior_runs} ${m.retrieved_from_prior_runs === 1 ? "memory" : "memories"} retrieved from prior runs ` +
        `(H-MEM holds ${m.memories_by_layer.long_term} long-term, ${m.memories_by_layer.working} working, ${m.memories_by_layer.short_term} short-term). ` +
        `The World Model holds ${w.facts_total} ${w.facts_total === 1 ? "fact" : "facts"} (${w.verified_facts_total} verified) from ${w.runs_ingested} ${w.runs_ingested === 1 ? "run" : "runs"}; ` +
        `${w.facts_this_run} from this run.`
      : "Memory figures were not recorded for this run.";

  const t = r.totals ?? {};
  $("totals").textContent =
    `${t.model_calls ?? 0} model calls, ${t.signed_receipts ?? 0} signed receipts, ` +
    `${(t.tokens_in ?? 0).toLocaleString()} tokens in, ${(t.tokens_out ?? 0).toLocaleString()} tokens out.`;

  $("run-log").replaceChildren(...runLog.map((line) => el("li", { text: line })));
  $("error-block").hidden = true;
  progress.hidden = true;
  $("working").hidden = false;
  syncWorking();
  results.hidden = false;
}

/** Hides the disclosure's sections that have nothing to show (an error leaves most of them empty). */
function syncWorking() {
  for (const sec of document.querySelectorAll("#working .wsec")) {
    if (sec.id === "error-block" || sec.id === "agent-notes-block") continue;
    const content = sec.querySelector("ol, ul, dl, tbody, p");
    sec.hidden = !content || (content.children.length === 0 && !content.textContent.trim());
  }
}

/** Results area while a run works: the summary keeps its place and the progress list sits below it. */
function showRunning() {
  runLog = [];
  progressList.replaceChildren();
  const summary = $("summary");
  summary.classList.add("pending");
  summary.textContent = "Working on your answer…";
  $("results-meta").classList.add("waiting");
  $("sample-badge").hidden = true;
  $("run-error").hidden = true;
  $("claims").replaceChildren();
  for (const id of ["unanswered-block", "notes-block"]) $(id).hidden = true;
  $("working").hidden = true;
  $("working").open = false;
  progress.hidden = false;
  results.hidden = false;
}

/** The run failed: one plain message on the page; the technical detail goes under the disclosure. */
function showFailure(detail) {
  const summary = $("summary");
  summary.classList.remove("pending");
  summary.textContent = "No answer this time.";
  $("run-error").hidden = false;
  progress.hidden = true;
  $("error-detail").textContent = detail;
  $("error-block").hidden = false;
  $("run-log").replaceChildren(...runLog.map((line) => el("li", { text: line })));
  for (const id of ["queries", "sections-read", "definitions", "agent-notes"]) $(id).replaceChildren();
  $("receipts").tBodies[0].replaceChildren();
  $("memory-line").textContent = "";
  $("totals").textContent = "";
  $("agent-notes-block").hidden = true;
  $("working").hidden = false;
  syncWorking();
  results.hidden = false;
}

function finish() {
  running = false;
  runButton.disabled = false;
  runButton.removeAttribute("aria-busy");
  runButton.textContent = "Run again";
  source?.close();
  source = null;
}

async function startRun(event) {
  event.preventDefault();
  if (running) return; // one run at a time: Enter in a field cannot submit twice
  const { profile, question, problems } = readForm();
  formError.hidden = problems.length === 0;
  formError.textContent = problems.join(" ");
  if (problems.length) return;

  running = true;
  runButton.disabled = true;
  runButton.setAttribute("aria-busy", "true");
  runButton.textContent = "Running…";
  $("how").hidden = true; // the explainer is for before the first run
  showRunning();

  let runId;
  try {
    const res = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile, question }) });
    const body = await res.json();
    if (!res.ok) throw new Error((body.issues ?? [body.error]).join("; "));
    runId = body.run_id;
  } catch (err) {
    showFailure(`Could not start the run: ${err.message}`);
    finish();
    return;
  }

  let done = false;
  source = new EventSource(`/api/runs/${runId}/events`);
  const onStep = (e) => {
    const ev = JSON.parse(e.data);
    logEvent(ev);
    addProgress(ev.text, ev.agent); // tool calls are folded into their result's line
  };
  source.addEventListener("status", onStep);
  source.addEventListener("trace", onStep);
  source.addEventListener("verdict", onStep);
  source.addEventListener("result", (e) => {
    done = true;
    const ev = JSON.parse(e.data);
    // the technical log moves into the disclosure; nothing technical stays above the answer
    renderResult(ev.data);
    finish();
    $("summary").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  source.addEventListener("failed", (e) => {
    done = true;
    const ev = JSON.parse(e.data);
    logEvent(ev);
    showFailure(ev.detail || ev.data?.error || ev.text);
    finish();
  });
  source.onerror = async () => {
    if (done) return;
    // the stream dropped: fall back to the stored result if the run has finished
    source?.close();
    const res = await fetch(`/api/runs/${runId}`).catch(() => null);
    const body = res?.status === 200 ? await res.json().catch(() => null) : null;
    if (body?.checked) renderResult(body);
    else showFailure(`The event stream closed before the run finished (GET /api/runs/${runId}: ${res ? `HTTP ${res.status}` : "no response"}).`);
    finish();
  };
}

/* ------------------------------------------------------------------ drawer */

/**
 * Statute text as paragraphs: a new paragraph at each subsection "(1)", "(2)" that starts a sentence,
 * and an indented one at each list item "(a)", "(b)" after a colon or semicolon. A cross-reference
 * such as "subsection (1) of this section" stays inline.
 */
function paragraphs(text) {
  const parts = text.split(/(?<=[.:;—]|^)\s+(?=\((?:\d+[A-Z]?|[a-z]{1,4})\)\s)/);
  return parts.map((p) => el("p", { className: /^\([a-z]{1,4}\)\s/.test(p) ? "item" : "", text: p }));
}

/** Wraps the first quoted occurrence of `term` in a <mark> and scrolls to it. */
function highlightTerm(container, term) {
  const re = new RegExp(`["“]${escapeRe(term)}["”]`, "i");
  for (const p of container.querySelectorAll("p")) {
    const m = re.exec(p.textContent);
    if (!m) continue;
    const full = p.textContent;
    const mark = el("mark", { text: m[0] });
    p.replaceChildren(full.slice(0, m.index), mark, full.slice(m.index + m[0].length));
    mark.scrollIntoView({ block: "center" });
    return;
  }
}

/** Keeps Tab and Shift+Tab inside an open modal dialog, and returns focus to the opener on close. */
function holdFocus(dialog) {
  dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = [...dialog.querySelectorAll("button, [href], input, select, textarea, summary, [tabindex]:not([tabindex='-1'])")].filter(
      (n) => !n.disabled && n.offsetParent !== null,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener("close", () => {
    const back = dialog.returnTo;
    dialog.returnTo = null;
    if (back?.isConnected) back.focus();
  });
  // a click on the backdrop (outside the dialog box) closes it
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
}

function openDialog(dialog, opener) {
  if (dialog.open) return;
  dialog.returnTo = opener ?? document.activeElement;
  dialog.showModal();
}

async function openSection(id, term, opener) {
  const drawer = $("drawer");
  const { act, no } = splitId(id);
  $("drawer-act").textContent = actName(act);
  $("drawer-title").textContent = no ? `Section ${no}` : id;
  $("drawer-meta").textContent = "Loading…";
  $("drawer-text").replaceChildren();
  openDialog(drawer, opener);
  try {
    const res = await fetch(`/api/sections/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    if (s.heading) $("drawer-title").textContent = `Section ${s.section_no ?? no}: ${s.heading}`;
    $("drawer-meta").textContent = [s.chapter, s.part].filter(Boolean).map(headingCase).join(" · ");
    $("drawer-text").replaceChildren(...paragraphs(s.text));
    if (term) highlightTerm($("drawer-text"), term);
  } catch {
    $("drawer-meta").textContent = "This section could not be loaded. Try again in a minute.";
  }
}
openSectionHandler = openSection;

/* ------------------------------------------------------------------ labels panel */

function fillLabelsPanel() {
  const row = (k) => [el("dt", { text: helpTerms[k].title }), el("dd", { text: helpTerms[k].text })];
  const keep = (ks) => ks.filter((k) => helpTerms[k]);
  $("labels-verdicts").replaceChildren(...keep(["supported", "qualified", "struck", "unchecked"]).flatMap(row));
  $("labels-types").replaceChildren(...keep(["obligation", "exemption"]).flatMap(row));
}
$("labels-open").addEventListener("click", (e) => {
  fillLabelsPanel();
  openDialog($("labels-panel"), e.currentTarget);
});
$("labels-close").addEventListener("click", () => $("labels-panel").close());
$("drawer-close").addEventListener("click", () => $("drawer").close());
holdFocus($("labels-panel"));
holdFocus($("drawer"));

/* ------------------------------------------------------------------ start */

form.addEventListener("submit", startRun);
fillForm(AMAKA, DEFAULT_QUESTION);

fetch("/api/acts")
  .then((r) => r.json())
  .then((acts) => {
    actTitles = Object.fromEntries(acts.map((a) => [a.act_id, a.act_title]));
  })
  .catch(() => {});

fetch("help.json")
  .then((r) => r.json())
  .then((h) => {
    helpTerms = h.terms ?? {};
    attachHelpSlots();
  })
  .catch(() => {
    // without the glossary the page works the same, minus the "?" buttons
  });
