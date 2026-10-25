// Statute text as blocks for the drawer: paragraphs at subsections "(1)", "(2)", and nested list items
// at "(a)", "(b)" and "(i)", "(ii)" where the marker starts a clause. Pure; no DOM.

const ROMAN = /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv)$/;

/**
 * "NTA-2025-s143" -> { act: "NTA-2025", no: "143" }; a Schedule item "TLA-1998-sch-III-20" ->
 * { act: "TLA-1998", part: "III", item: "20" }. Fields that do not apply are "".
 */
export function splitLawId(id) {
  const item = /^(.*-\d{4})-sch-([IVX]+)-(\d+)$/.exec(id);
  if (item) return { act: item[1], no: "", part: item[2], item: item[3] };
  const m = /^(.*-\d{4})-s(\d+)$/.exec(id);
  return m ? { act: m[1], no: m[2], part: "", item: "" } : { act: id, no: "", part: "", item: "" };
}

/** Where in its Act an id points: "s. 143", or "Schedule, Part III, item 20" for a Schedule item. */
export function lawRef(id) {
  const p = splitLawId(id);
  if (p.item) return `Schedule, Part ${p.part}, item ${p.item}`;
  return p.no ? `s. ${p.no}` : id;
}

/**
 * A marker starts a clause after a colon, semicolon or dash (optionally "; and" / "; or"), or at the
 * start. In an interpretation section, each `; "term" means ...` entry also starts a new paragraph.
 */
const SPLIT = /(?<=^|[:;—–]|[:;—–]\s(?:and|or)|\.)\s+(?=\((?:\d+[A-Z]?|[a-z]{1,4})\)\s)|(?<=[;—–])\s+(?=["“][^"”]{1,60}["”]\s)/;

/**
 * Splits a section into blocks: { level: 0, text } for paragraphs (a subsection, or text with no
 * markers), { level: 1, text } for "(a)" items and { level: 2, text } for "(i)" items. "(i)" after "(h)",
 * "(v)" after "(u)" and "(x)" after "(w)" are letters, not roman numerals. A cross-reference such as
 * "subsection (1) of this section" stays inside its sentence.
 */
export function lawBlocks(text) {
  const parts = String(text ?? "")
    .split(SPLIT)
    .map((p) => p.trim())
    .filter(Boolean);
  const blocks = [];
  let lastLetter = ""; // the last "(a)"-style marker in this subsection
  let romanTop = false; // this subsection's list is numbered (i), (ii) with no letters above it
  for (const part of parts) {
    const m = /^\((\d+[A-Z]?|[a-z]{1,4})\)\s/.exec(part);
    const marker = m?.[1] ?? "";
    if (!m || /^\d/.test(marker)) {
      blocks.push({ level: 0, text: part });
      [lastLetter, romanTop] = ["", false];
      continue;
    }
    const nextLetter = lastLetter !== "" && marker.length === 1 && marker.charCodeAt(0) === lastLetter.charCodeAt(0) + 1;
    if (ROMAN.test(marker) && !nextLetter && (romanTop || lastLetter === "")) {
      romanTop = true;
      blocks.push({ level: 1, text: part });
    } else if (ROMAN.test(marker) && !nextLetter) {
      blocks.push({ level: 2, text: part });
    } else {
      blocks.push({ level: 1, text: part });
      lastLetter = marker;
    }
  }
  return blocks;
}
