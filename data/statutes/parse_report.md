# Parse report

## Sections per Act

- NTA-2025: 202
- NTAA-2025: 148
- NRSEA-2025: 43
- JRBEA-2025: 61

## 5 shortest sections

- NTA-2025-s202: 51 chars
- NRSEA-2025-s2: 60 chars
- JRBEA-2025-s2: 64 chars
- NTAA-2025-s148: 66 chars
- NRSEA-2025-s43: 79 chars

## 5 longest sections

- NTA-2025-s201: 21854 chars
- NTA-2025-s118: 20970 chars
- NTAA-2025-s147: 11313 chars
- NTA-2025-s188: 9755 chars
- NTA-2025-s17: 8173 chars

## Sections with empty text

None.

## Sections with heading longer than 200 characters

None.

## Headings missing

- NTA-2025: 5 of 202 (sections: 106, 136, 144, 157, 195)
- NTAA-2025: 7 of 148 (sections: 16, 20, 34, 46, 104, 123, 138)
- NRSEA-2025: 2 of 43 (sections: 7, 38)
- JRBEA-2025: 0 of 61 (sections: none)

Headings are the margin notes printed beside each section. Words the text layer glued across the
body/margin boundary are split by character position; the remaining gaps are sections whose margin
note was not found next to the section start.

## De-hyphenation

Line-break hyphens are removed from `text` only when the hyphen ends a printed line directly after a
letter and the next line starts lowercase ("Establish-" + "ment" -> "Establishment"). Hyphens elsewhere
("non-resident") are untouched. A genuine compound that happens to break at a line end would also be
joined; that is a known limitation of the rule. The same rule is applied inside a single extracted line
("allow- ances"), except before "and"/"or"/"to" so suspended hyphens like "pre- and post-" survive.

## Not included

Schedule text is excluded: each Act's text stops at its first Schedule heading.
- NTA-2025: has Schedules (first heading found: "SCHEDULES")
- NTAA-2025: has Schedules (first heading found: "SCHEDULES")
- NRSEA-2025: has Schedules (first heading found: "SCHEDULES")
- JRBEA-2025: has Schedules (first heading found: "SCHEDULES")
