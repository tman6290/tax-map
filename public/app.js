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

/** Creates an element with optional class and text; children may be nodes or strings. */
function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

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
  if (!profile.lga) problems.push("Enter the Local Government Area.");
  if (!Number.isInteger(employees) || employees < 0) problems.push("Employees must be a whole number, 0 or more.");
  if (f.question.value.trim().length < 3) problems.push("Enter a question.");
  return { profile, question: f.question.value.trim(), problems };
}

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

function addProgress(text, agent) {
  const li = el("li", { className: `agent-${agent}`, text });
  progressList.append(li);
  progressList.scrollTop = progressList.scrollHeight;
}

const VERDICT_LABEL = { supported: "Supported", qualified: "Qualified", struck: "Struck", unchecked: "Not verified" };

function claimCard(c) {
  const v = c.verdict;
  const card = el("details", { className: `claim v-${v}` });
  const head = el(
    "div",
    { className: "claim-head" },
    el("span", { className: `chip v-${v}`, text: VERDICT_LABEL[v] ?? v }),
    el("span", { className: "claim-type", text: c.claim.type === "exemption" ? "Exemption" : "Obligation" }),
    el("span", { className: "claim-toggle", attrs: { "aria-hidden": "true" } }),
  );
  const text = el("p", { className: "claim-text", text: c.claim.text });
  if (v === "struck") text.prepend(el("span", { className: "visually-hidden", text: "Struck: " }));
  card.append(el("summary", {}, head, text, el("p", { className: "citation", text: citation(c.claim.section_ids) })));

  const body = el("div", { className: "claim-body" });
  body.append(el("h4", { text: "Quote" }));
  if (c.quote && c.quote_verified) body.append(el("blockquote", { text: c.quote }));
  else body.append(el("p", { className: "unverified", text: c.quote ? "The Critic's quote could not be found in the cited text." : "No quote: the cited text does not establish this claim." }));

  body.append(el("h4", { text: "Critic's reason" }), el("p", { className: "reason", text: c.reason }));
  if (c.qualifier) body.append(el("h4", { text: "Qualifier" }), el("p", { className: "qualifier", text: c.qualifier }));

  const defs = c.definitions ?? [];
  if (defs.length) {
    const byId = new Map();
    for (const d of defs) byId.set(d.section_id, [...(byId.get(d.section_id) ?? []), d.term]);
    const ul = el("ul", { className: "plain-list compact" });
    for (const [id, terms] of byId) ul.append(el("li", { text: `${citation([id])}: ${terms.map((t) => `“${t}”`).join(", ")}` }));
    body.append(el("h4", { text: "Definitions used" }), ul);
  }

  const links = el("ul", { className: "section-links" });
  for (const id of c.claim.section_ids) {
    const b = el("button", { className: "link-button", text: `Read ${citation([id])} in full`, attrs: { type: "button" } });
    b.addEventListener("click", () => openSection(id));
    links.append(el("li", {}, b));
  }
  body.append(el("h4", { text: "Full text" }), links);
  card.append(body);
  return card;
}

function fillList(listId, blockId, items) {
  const list = $(listId);
  list.replaceChildren(...items.map((t) => el("li", { text: t })));
  $(blockId).hidden = items.length === 0;
}

function renderResult(r) {
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
  summary.replaceChildren(
    `${plural(n.obligations, "obligation", "obligations")}, ${plural(n.exemptions, "exemption", "exemptions")}, ${n.struck} struck, ${n.unchecked} could not be verified`,
  );
  if (r.mode === "sample") summary.append(el("span", { className: "badge", text: "Sample run", attrs: { title: `Replay of the recorded run “${r.sample}”` } }));

  $("claims").replaceChildren(...claims.map(claimCard));
  fillList("unanswered", "unanswered-block", r.draft?.unanswered ?? []);
  fillList("notes", "notes-block", r.draft?.notes ?? []);

  $("queries").replaceChildren(
    ...(r.queries ?? []).map((q) =>
      el("li", {}, `${q.row_count} ${q.row_count === 1 ? "row" : "rows"}${q.error ? ` (rejected: ${q.error})` : ""}`, el("code", { className: "sql", text: q.sql })),
    ),
  );
  $("sections-read").replaceChildren(
    ...(r.sections_read ?? []).map((s) => {
      const b = el("button", { className: "link-button", text: s.section_id, attrs: { type: "button" } });
      b.addEventListener("click", () => openSection(s.section_id));
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
        el("td", { text: x.agent }),
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

  results.hidden = false;
}

function finish() {
  runButton.disabled = false;
  runButton.textContent = "Run again";
  source?.close();
  source = null;
}

async function startRun(event) {
  event.preventDefault();
  const { profile, question, problems } = readForm();
  formError.hidden = problems.length === 0;
  formError.textContent = problems.join(" ");
  if (problems.length) return;

  runButton.disabled = true;
  runButton.textContent = "Running…";
  progressList.replaceChildren();
  $("how").hidden = true; // the explainer is for before the first run
  progress.hidden = false;
  results.hidden = true;
  $("working").open = false;

  let runId;
  try {
    const res = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile, question }) });
    const body = await res.json();
    if (!res.ok) throw new Error((body.issues ?? [body.error]).join("; "));
    runId = body.run_id;
  } catch (err) {
    addProgress(`Could not start the run: ${err.message}`, "system");
    finish();
    return;
  }

  let done = false;
  source = new EventSource(`/api/runs/${runId}/events`);
  const onStep = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.text) addProgress(ev.text, ev.agent); // tool calls are folded into their result's line
  };
  source.addEventListener("status", onStep);
  source.addEventListener("trace", onStep);
  source.addEventListener("verdict", onStep);
  source.addEventListener("result", (e) => {
    done = true;
    const ev = JSON.parse(e.data);
    const li = el("li", { className: "agent-system done", text: "Done." });
    progressList.append(li);
    renderResult(ev.data);
    finish();
    $("summary").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  source.addEventListener("failed", (e) => {
    done = true;
    addProgress(JSON.parse(e.data).text, "system");
    finish();
  });
  source.onerror = async () => {
    if (done) return;
    // the stream dropped: fall back to the stored result if the run has finished
    source?.close();
    const res = await fetch(`/api/runs/${runId}`).catch(() => null);
    if (res?.status === 200) {
      renderResult(await res.json());
      finish();
    } else {
      addProgress("Lost the connection to the server while the run was in progress.", "system");
      finish();
    }
  };
}

/** Splits statute text into paragraphs at its subsection markers "(1)", "(2)", ... */
function paragraphs(text) {
  return text.split(/\s(?=\(\d+\)\s)/).map((p) => el("p", { text: p }));
}

async function openSection(id) {
  const drawer = $("drawer");
  $("drawer-title").textContent = citation([id]);
  $("drawer-meta").textContent = "Loading…";
  $("drawer-text").replaceChildren();
  if (!drawer.open) drawer.showModal();
  try {
    const res = await fetch(`/api/sections/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    $("drawer-meta").textContent = [s.heading, s.chapter, s.part].filter(Boolean).join(" · ");
    $("drawer-text").replaceChildren(...paragraphs(s.text));
  } catch (err) {
    $("drawer-meta").textContent = `Could not load ${id}: ${err.message}`;
  }
}

$("drawer-close").addEventListener("click", () => $("drawer").close());
$("drawer").addEventListener("click", (e) => {
  if (e.target === $("drawer")) $("drawer").close(); // click on the backdrop
});

form.addEventListener("submit", startRun);
fillForm(AMAKA, DEFAULT_QUESTION);
fetch("/api/acts")
  .then((r) => r.json())
  .then((acts) => {
    actTitles = Object.fromEntries(acts.map((a) => [a.act_id, a.act_title]));
  })
  .catch(() => {});
