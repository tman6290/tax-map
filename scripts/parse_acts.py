"""Parse the four 2025 Nigerian tax Acts (gazette/ctc PDFs) and the Taxes and Levies (Approved List for
Collection) Act 1998 (other/) into section-level JSON, and that Act's Schedule into item-level JSON.

PDFs live outside the repo; set TAXMAP_ACTS_DIR to override the default location.
Outputs: data/statutes/{sections.json,acts.json,levies.json,parse_report.md}.

Layout notes: each Act prints the section heading as a margin note in a column to
the right of the body text. Words are split by x-position into body vs margin so
the heading never leaks into the statute text. Section starts are only accepted
in strict numeric sequence (1, 2, 3, ...) to avoid matching list items.
"""
from __future__ import annotations

import collections
import hashlib
import json
import logging
import os
import re
import sys
from pathlib import Path

import pdfplumber

logging.disable(logging.CRITICAL)  # pdfminer font warnings

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "statutes"
ACTS_DIR = Path(os.environ.get("TAXMAP_ACTS_DIR", r"C:\Users\LENOVO\Desktop\hackathon-scratch\acts"))

# header_cut: words with top < header_cut are running page headers.
NTA_COPIES = {
    "lirs": {"file": "gazette/NTA-2025-gazette-lirs.pdf", "header_cut": 110},
    "fgp": {"file": "gazette/NTA-2025-gazette-fgp.pdf", "header_cut": 130},
}
NTA_COPY = os.environ.get("TAXMAP_NTA_COPY", "fgp")

ACTS = [
    {
        "act_id": "NTA-2025",
        "act_title": "Nigeria Tax Act, 2025",
        "short_title": "Nigeria Tax Act",
        **NTA_COPIES[NTA_COPY],
    },
    {
        "act_id": "NTAA-2025",
        "act_title": "Nigeria Tax Administration Act, 2025",
        "short_title": "Nigeria Tax Administration Act",
        "file": "gazette/NTAA-2025-gazette-gng.pdf",
        "header_cut": 125,
    },
    {
        "act_id": "NRSEA-2025",
        "act_title": "Nigeria Revenue Service (Establishment) Act, 2025",
        "short_title": "Nigeria Revenue Service (Establishment) Act",
        "file": "ctc/NRSA-2025-ctc.pdf",
        "header_cut": 155,
        # notes touch the body column here, so no empty gutter exists; cut at measured x positions
        "fixed_gutters": {1: ("right", 439.5), 0: ("left", 152.0)},
    },
    {
        "act_id": "JRBEA-2025",
        "act_title": "Joint Revenue Board of Nigeria (Establishment) Act, 2025",
        "short_title": "Joint Revenue Board of Nigeria (Establishment) Act",
        "file": "ctc/JRBA-2025-ctc.pdf",
        "header_cut": 160,
    },
]

SCHEDULE_RE = re.compile(r"^(?:(?:FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH)\s+)?SCHEDULES?\b")
PART_RE = re.compile(r"^PART\s+(?:[IVXLC]+|\d+)\b")
CHAPTER_RE = re.compile(r"^CHAPTER\s+(?:[A-Z]+|\d+)\b")
CAPS_RE = re.compile(r"^[^a-z]*[A-Z][^a-z]*$")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest().upper()


def read_hashes(folder: Path) -> dict[str, str]:
    """File name -> SHA-256 from a folder's hashes.txt.

    Two formats: "<hash>  <name>" lines (gazette/, ctc/), or PowerShell Get-FileHash list output
    ("Path : <full path>" then "Hash : <hash>", UTF-16 with a BOM) as in other/.
    """
    raw = (folder / "hashes.txt").read_bytes()
    text = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-8-sig")
    lines = text.splitlines()
    out = {}
    if any(re.match(r"^\s*Path\s*:", ln) for ln in lines):
        path = None
        for line in lines:
            m = re.match(r"^\s*(Path|Hash)\s*:\s*(.+?)\s*$", line)
            if not m:
                continue
            if m.group(1) == "Path":
                path = m.group(2)
            elif path:
                out[re.split(r"[\\/]", path)[-1]] = m.group(2).upper()
                path = None
        return out
    for line in lines:
        parts = line.split()
        if len(parts) >= 2:
            out[parts[-1]] = parts[0].upper()
    return out


def group_lines(words, tol=3.0):
    """Cluster words into visual lines by their top coordinate."""
    lines: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if lines and abs(lines[-1][0]["top"] - w["top"]) <= tol:
            lines[-1].append(w)
        else:
            lines.append([w])
    return lines


def find_gutter(words, min_gap) -> tuple[str, float] | None:
    """Locate the margin-note column on a page as a vertical strip no word crosses.

    Pages alternate (recto: notes on the right, verso: notes on the left). Returns
    ("right", x) when words with x0 >= x are margin notes, ("left", x) when words
    with x1 <= x are, or None when the page has no margin column.
    """
    if len(words) < 8:
        return None
    lo, hi = int(min(w["x0"] for w in words)), int(max(w["x1"] for w in words)) + 1
    cover = [0] * (hi + 2)
    for w in words:
        for x in range(int(w["x0"]) + 1, int(w["x1"])):
            cover[x] += 1
    runs, start = [], None
    for x in range(lo, hi + 1):
        if cover[x] == 0 and start is None:
            start = x
        elif cover[x] != 0 and start is not None:
            runs.append((start, x - 1))
            start = None
    best = None
    for a, b in runs:
        if b - a < min_gap:
            continue
        if 35 <= a - lo <= 130:
            cand = ("left", (a + b) / 2, b - a)
        elif 35 <= hi - b <= 130:
            cand = ("right", (a + b) / 2, b - a)
        else:
            continue
        if best is None or cand[2] > best[2]:  # the real gutter is the widest empty strip
            best = cand
    return (best[0], best[1]) if best else None


SPLIT_GLUED = os.environ.get("TAXMAP_SPLIT_GLUED", "1") == "1"
SPLIT_SLACK = 4.0  # chars this close to the cut count as margin (small-caps first letters sit left of it)


def split_at_gutter(words, gutter):
    """Split words the text layer glued across the body/margin boundary, using char positions."""
    side, g = gutter
    out = []
    for w in words:
        crosses = w["x0"] < g < w["x1"] if side == "right" else w["x0"] < g < w["x1"]
        if not crosses:
            out.append(w)
            continue
        if side == "right":
            is_margin = lambda c: c["x0"] >= g - SPLIT_SLACK
        else:
            is_margin = lambda c: c["x1"] <= g + SPLIT_SLACK
        for part in ([c for c in w["chars"] if not is_margin(c)], [c for c in w["chars"] if is_margin(c)]):
            if part:
                out.append(
                    {
                        "text": "".join(c["text"] for c in part),
                        "x0": min(c["x0"] for c in part),
                        "x1": max(c["x1"] for c in part),
                        "top": w["top"],
                    }
                )
    return out


def page_words(page, header_cut):
    return [w for w in page.extract_words(x_tolerance=2, return_chars=True) if w["top"] >= header_cut]


def doc_gutters(pdf, header_cut, min_gap, fixed=None) -> dict[int, tuple[str, float] | None]:
    """Per-page gutters; pages where detection fails borrow the median of same-parity pages.

    Borrowing is safe: a page without margin notes has no words in the strip, so the
    split changes nothing there.
    """
    if fixed:
        return {i: fixed[i % 2] for i in range(1, len(pdf.pages) + 1)}
    found = {i: find_gutter(page_words(pg, header_cut), min_gap) for i, pg in enumerate(pdf.pages, start=1)}
    median = {}
    for parity in (0, 1):
        same = sorted(v for j, v in found.items() if v is not None and j % 2 == parity and j > 8)
        median[parity] = same[len(same) // 2] if same else None
    out = {}
    for i, g in found.items():
        m = median[i % 2]
        if m is not None and g is None:
            g = m  # missing detections defer to the document's norm
        out[i] = g
    return out


def extract_page_lines(page, header_cut, gutter):
    words = page_words(page, header_cut)
    if gutter is not None and SPLIT_GLUED:
        words = split_at_gutter(words, gutter)
    body, margin = [], []
    for ln in group_lines(words, tol=4.0):
        ln.sort(key=lambda w: w["x0"])
        if gutter is None:
            b, m = ln, []
        elif gutter[0] == "right":
            b = [w for w in ln if w["x0"] < gutter[1]]
            m = [w for w in ln if w["x0"] >= gutter[1]]
        else:
            b = [w for w in ln if w["x1"] > gutter[1]]
            m = [w for w in ln if w["x1"] <= gutter[1]]
        top = ln[0]["top"]
        if b:
            body.append((top, " ".join(w["text"] for w in b)))
        if m:
            margin.append((top, " ".join(w["text"] for w in m)))
    return body, margin


def join_heading(parts: list[str]) -> str:
    out = ""
    for p in parts:
        if out.endswith("-"):
            out = out[:-1] + p  # margin notes hyphenate long words ("Ascertain-" "ment")
        else:
            out = (out + " " + p).strip()
    return re.sub(r"\s+", " ", out).strip()


def join_lines(lines: list[str]) -> str:
    """Join visual lines, undoing line-break hyphenation.

    A hyphen is dropped only when it ends a line right after a letter and the next
    line starts with a lowercase letter ("Establish-" + "ment"). Hyphens that are
    not at a line end ("non-resident") are never touched.
    """
    out = ""
    for ln in lines:
        ln = ln.strip()
        if out and re.search(r"[A-Za-z]-$", out) and ln[:1].islower():
            out = out[:-1] + ln
        else:
            out = (out + " " + ln) if out else ln
    out = re.sub(r"\s+", " ", out).strip()
    # a break hyphen can also survive inside one extracted line ("allow- ances"); suspended hyphens
    # ("pre- and post-", "x- or y") are legitimate and kept
    return re.sub(r"(?<=[A-Za-z]{3})- (?!(?:and|or|to))(?=[a-z])", "", out)


def parse_act(cfg: dict, pdf_path: Path) -> tuple[list[dict], str | None]:
    """Return (sections, first Schedule heading found after the sections, if any)."""
    sections: list[dict] = []
    schedule_heading = None
    chapter = None
    cur: dict | None = None
    expected = 1
    started = False
    ended = False
    part = None
    heading_kind = None  # "part"/"chapter" while consuming caps continuation lines

    with pdfplumber.open(pdf_path) as pdf:
        gutters = doc_gutters(pdf, cfg["header_cut"], cfg.get("min_gap", 5), cfg.get("fixed_gutters"))
        for pno, page in enumerate(pdf.pages, start=1):
            if ended:
                break
            body, margin = extract_page_lines(page, cfg["header_cut"], gutters[pno])
            starts = []  # (top, section dict) for this page, to attach margin headings
            for top, text in body:
                if not started:
                    if re.match(r"^EN[AE]CTED by the National", text):
                        started = True
                    continue
                if SCHEDULE_RE.match(text):
                    ended = True
                    schedule_heading = text
                    break
                if PART_RE.match(text):
                    part = text
                    heading_kind = "part"
                    continue
                if CHAPTER_RE.match(text):
                    chapter = text
                    part = None  # Part numbering restarts in each Chapter
                    heading_kind = "chapter"
                    continue
                if heading_kind and CAPS_RE.match(text) and not re.match(r"^\d+\.", text):
                    if heading_kind == "part":
                        part += " " + text
                    else:
                        chapter += " " + text
                    continue
                heading_kind = None
                m = re.match(rf"^{expected}\s*[.—–]\s*(.*)$", text)
                if m:
                    cur = {
                        "section_no": str(expected),
                        "heading": "",
                        "_parts": [m.group(1)],
                        "part": part,
                        "chapter": chapter,
                        "page_start": pno,
                        "page_end": pno,
                    }
                    sections.append(cur)
                    starts.append((top, cur))
                    expected += 1
                elif cur is not None:
                    cur["_parts"].append(text)
                    cur["page_end"] = pno
            # attach margin-note blocks to the nearest section start on this page
            blocks: list[list[tuple[float, str]]] = []
            for top, text in margin:
                if blocks and top - blocks[-1][-1][0] <= 16:
                    blocks[-1].append((top, text))
                else:
                    blocks.append([(top, text)])
            for blk in blocks:
                if not starts:
                    continue
                s_top, sec = min(starts, key=lambda s: abs(s[0] - blk[0][0]))
                if abs(s_top - blk[0][0]) <= 25:
                    sec["heading"] = join_heading([sec["heading"]] + [t for _, t in blk]) if sec["heading"] else join_heading([t for _, t in blk])
    return sections, schedule_heading


# The Taxes and Levies (Approved List for Collection) Act (Cap. T2, LFN), 1998 Schedule only: the 2015
# Amendment Order was set aside by the Federal High Court in 2020 and nothing from it is included.
TLA = {
    "act_id": "TLA-1998",
    "act_title": "Taxes and Levies (Approved List for Collection) Act, 1998",
    "short_title": "Taxes and Levies (Approved List for Collection) Act",
    "year": 1998,
    "file": "other/Nigeria_8_NigeriaTaxesLevies1998.pdf",
}
# Schedule Part -> the tier s. 1(1) makes responsible for collecting it
TLA_PART_TIER = {"I": "federal", "II": "state", "III": "lga"}
TLA_HEADER_RE = re.compile(r"^(?:• Laws • Subsidiary Legislation •|LAWS)$")


def parse_tla(pdf_path: Path) -> tuple[list[dict], list[dict]]:
    """Return (sections, schedule items) of the Act.

    One text column, no margin notes: each section starts with "<n>. <heading>" on its own line and the
    Schedule lists "PART I" .. "PART III", each followed by its heading line and items "1.", "2.", ...
    The body starts after "[Commencement.]" (the arrangement of sections before it repeats the headings),
    and the Schedule ends at the compilation's "CHAPTER T2" trailer.
    """
    lines: list[tuple[int, str]] = []
    with pdfplumber.open(pdf_path) as pdf:
        for pno, page in enumerate(pdf.pages, start=1):
            for ln in (page.extract_text() or "").splitlines():
                ln = ln.strip()
                if ln and not TLA_HEADER_RE.match(ln):
                    lines.append((pno, ln))

    sections: list[dict] = []
    items: list[dict] = []
    started = in_schedule = False
    expected = 1
    cur: dict | None = None
    part = None
    part_title = ""
    want_title = False
    for pno, text in lines:
        if not started:
            started = text == "[Commencement.]"
            continue
        if not in_schedule:
            if text == "Schedule":
                in_schedule, cur = True, None
                continue
            m = re.match(rf"^{expected}\.\s+(.+)$", text)
            if m:
                cur = {"section_no": str(expected), "heading": m.group(1).strip(), "_parts": [], "page_start": pno, "page_end": pno}
                sections.append(cur)
                expected += 1
            elif cur is not None:
                cur["_parts"].append(text)
                cur["page_end"] = pno
            continue
        if text.startswith("CHAPTER T2"):
            break
        if text == "[Section 1.]":
            continue
        m = re.match(r"^PART\s+([IVX]+)$", text)
        if m:
            part, want_title, expected, cur = m.group(1), True, 1, None
            continue
        if want_title:
            part_title, want_title = text, False
            continue
        m = re.match(rf"^{expected}\.\s+(.+)$", text)
        if m and part:
            cur = {"part": part, "part_title": part_title, "item_no": str(expected), "_parts": [m.group(1)], "page": pno}
            items.append(cur)
            expected += 1
        elif cur is not None:
            cur["_parts"].append(text)
    for s in sections + items:
        s["text"] = join_lines(s.pop("_parts"))
    return sections, items


def tla_records(pdf_path: Path, digest: str) -> tuple[list[dict], list[dict]]:
    secs, items = parse_tla(pdf_path)
    sections = [
        {
            "section_id": f"{TLA['act_id']}-s{s['section_no']}",
            "act_id": TLA["act_id"],
            "act_title": TLA["act_title"],
            "section_no": s["section_no"],
            "heading": s["heading"],
            "text": s["text"],
            "chapter": None,
            "part": None,
            "tier": "federal",
            "source_file": TLA["file"],
            "source_sha256": digest,
            "page_start": s["page_start"],
            "page_end": s["page_end"],
        }
        for s in secs
    ]
    levies = [
        {
            "item_id": f"{TLA['act_id']}-sch-{i['part']}-{i['item_no']}",
            "act_id": TLA["act_id"],
            "part": i["part"],
            "part_title": i["part_title"],
            "tier": TLA_PART_TIER[i["part"]],
            "item_no": i["item_no"],
            "text": i["text"],
            "source_file": TLA["file"],
            "source_sha256": digest,
            "page": i["page"],
        }
        for i in items
    ]
    return sections, levies


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    all_sections: list[dict] = []
    acts_out: list[dict] = []
    schedules: dict[str, str | None] = {}
    for cfg in ACTS:
        pdf_path = ACTS_DIR / cfg["file"]
        digest = sha256(pdf_path)
        listed = read_hashes(pdf_path.parent).get(pdf_path.name)
        if listed and listed != digest:
            print(f"HASH MISMATCH for {pdf_path.name}", file=sys.stderr)
            return 1
        secs, sched = parse_act(cfg, pdf_path)
        schedules[cfg["act_id"]] = sched
        for s in secs:
            text = join_lines(s.pop("_parts"))
            text = re.sub(r"^[—–-]+\s*", "", text)
            all_sections.append(
                {
                    "section_id": f"{cfg['act_id']}-s{s['section_no']}",
                    "act_id": cfg["act_id"],
                    "act_title": cfg["act_title"],
                    "section_no": s["section_no"],
                    "heading": s["heading"],
                    "text": text,
                    "chapter": s["chapter"],
                    "part": s["part"],
                    "tier": "federal",
                    "source_file": cfg["file"],
                    "source_sha256": digest,
                    "page_start": s["page_start"],
                    "page_end": s["page_end"],
                }
            )
        acts_out.append(
            {
                "act_id": cfg["act_id"],
                "act_title": cfg["act_title"],
                "short_title": cfg["short_title"],
                "year": 2025,
                "tier": "federal",
                "source_file": cfg["file"],
                "source_sha256": digest,
                "section_count": len(secs),
            }
        )
        print(f"{cfg['act_id']}: {len(secs)} sections")

    pdf_path = ACTS_DIR / TLA["file"]
    digest = sha256(pdf_path)
    listed = read_hashes(pdf_path.parent).get(pdf_path.name)
    if listed != digest:
        print(f"HASH {'MISMATCH' if listed else 'NOT LISTED'} for {pdf_path.name}", file=sys.stderr)
        return 1
    tla_sections, levies = tla_records(pdf_path, digest)
    all_sections += tla_sections
    acts_out.append(
        {
            "act_id": TLA["act_id"],
            "act_title": TLA["act_title"],
            "short_title": TLA["short_title"],
            "year": TLA["year"],
            "tier": "federal",
            "source_file": TLA["file"],
            "source_sha256": digest,
            "section_count": len(tla_sections),
        }
    )
    per_part = collections.Counter(i["part"] for i in levies)
    print(f"{TLA['act_id']}: {len(tla_sections)} sections; Schedule items " + ", ".join(f"Part {p} {n}" for p, n in per_part.items()))

    (OUT / "sections.json").write_text(json.dumps(all_sections, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "acts.json").write_text(json.dumps(acts_out, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "levies.json").write_text(json.dumps(levies, ensure_ascii=False, indent=2), encoding="utf-8")
    write_report(all_sections, acts_out, schedules, levies)
    return 0


def write_report(sections, acts, schedules, levies):
    lines = ["# Parse report", "", "## Sections per Act", ""]
    for a in acts:
        lines.append(f"- {a['act_id']}: {a['section_count']}")
    lines.append("")
    by = collections.defaultdict(list)
    for s in sections:
        by[s["act_id"]].append(s)
    ranked = sorted(sections, key=lambda s: len(s["text"]))
    lines += ["## 5 shortest sections", ""]
    lines += [f"- {s['section_id']}: {len(s['text'])} chars" for s in ranked[:5]]
    lines += ["", "## 5 longest sections", ""]
    lines += [f"- {s['section_id']}: {len(s['text'])} chars" for s in ranked[-5:][::-1]]
    empty = [s["section_id"] for s in sections if not s["text"]]
    long_h = [(s["section_id"], len(s["heading"])) for s in sections if len(s["heading"]) > 200]
    no_h = [s["section_id"] for s in sections if not s["heading"]]
    lines += ["", "## Sections with empty text", ""]
    lines += [f"- {x}" for x in empty] or ["None."]
    lines += ["", "## Sections with heading longer than 200 characters", ""]
    lines += [f"- {x}: {n} chars" for x, n in long_h] or ["None."]
    lines += ["", "## Headings missing", ""]
    for a in acts:
        miss = [s["section_no"] for s in sections if s["act_id"] == a["act_id"] and not s["heading"]]
        lines.append(f"- {a['act_id']}: {len(miss)} of {a['section_count']} (sections: {', '.join(miss) or 'none'})")
    lines += [
        "",
        "Headings are the margin notes printed beside each section. Words the text layer glued across the",
        "body/margin boundary are split by character position; the remaining gaps are sections whose margin",
        "note was not found next to the section start.",
        "",
        "## De-hyphenation",
        "",
        "Line-break hyphens are removed from `text` only when the hyphen ends a printed line directly after a",
        'letter and the next line starts lowercase ("Establish-" + "ment" -> "Establishment"). Hyphens elsewhere',
        '("non-resident") are untouched. A genuine compound that happens to break at a line end would also be',
        "joined; that is a known limitation of the rule. The same rule is applied inside a single extracted line",
        '("allow- ances"), except before "and"/"or"/"to" so suspended hyphens like "pre- and post-" survive.',
        "",
        "## Not included",
        "",
        "Schedule text of the 2025 Acts is excluded: each Act's text stops at its first Schedule heading.",
    ]
    for a in acts:
        if a["act_id"] == TLA["act_id"]:
            continue
        sched = schedules.get(a["act_id"])
        lines.append(f"- {a['act_id']}: " + (f'has Schedules (first heading found: "{sched}")' if sched else "no Schedule heading found"))
    lines += [
        "",
        f"## {TLA['act_id']} Schedule (levies.json)",
        "",
        "The Schedule of the Taxes and Levies (Approved List for Collection) Act is parsed item by item into",
        "`levies.json`, as printed in 1998. Nothing from the 2015 Amendment Order is included.",
        "",
    ]
    for part in TLA_PART_TIER:
        mine = [i for i in levies if i["part"] == part]
        title = mine[0]["part_title"] if mine else "(not found)"
        lines.append(f"- Part {part} ({TLA_PART_TIER[part]}), \"{title}\": {len(mine)} items")
    (OUT / "parse_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
