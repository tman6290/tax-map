# Sources

Statute text in `data/statutes/` is parsed from the PDFs below. The PDFs are not stored in this repo; they live in `C:\Users\LENOVO\Desktop\hackathon-scratch\acts\`. SHA-256 values are from each folder's `hashes.txt` and were re-checked against the files by `scripts/parse_acts.py`.

| act_id | Act | File | Folder | SHA-256 |
| --- | --- | --- | --- | --- |
| NTA-2025 | Nigeria Tax Act, 2025 | `NTA-2025-gazette-fgp.pdf` | `acts\gazette` | `41ABF6887BC58A3C97116FD9A048AA91AD49C1CAB156F39065A58401C0FCE94F` |
| NTAA-2025 | Nigeria Tax Administration Act, 2025 | `NTAA-2025-gazette-gng.pdf` | `acts\gazette` | `1602CF3245F250107E9BA0099C8755B52D04CD8A497A3C029772C624AB2C2625` |
| NRSEA-2025 | Nigeria Revenue Service (Establishment) Act, 2025 | `NRSA-2025-ctc.pdf` | `acts\ctc` | `B7072257F6D68DD99EC10F332FBDDB5FB507681B85172852A16510BFAFB87F0E` |
| JRBEA-2025 | Joint Revenue Board of Nigeria (Establishment) Act, 2025 | `JRBA-2025-ctc.pdf` | `acts\ctc` | `97B648230DEE2F6FC1E9F5248343DFB8D6C6D17B4C2D38ABE661ABEE6201E458` |
| TLA-1998 | Taxes and Levies (Approved List for Collection) Act, 1998 (Cap. T2) | `Nigeria_8_NigeriaTaxesLevies1998.pdf` | `acts\other` | `F2693F35B511672AF30BDE5F10680726C221DD55B07270EF932E00AE28053E3E` |

`acts\other\hashes.txt` is PowerShell `Get-FileHash` output (`Path` and `Hash` lines, UTF-16), not the `<hash>  <file>` format of the other two folders; `scripts/parse_acts.py` reads both.

## Data sources

Two public copies of the Nigeria Tax Act exist and their texts differ. The LIRS copy (`NTA-2025-gazette-lirs.pdf`, SHA-256 `F15EDD3BC428D03FDDBAC7DAE9D5C7025C161BC02A04E42E3123975553965B91`) has 203 sections: it includes an extra s89 "Petroleum royalty" that the other copy lacks, which shifts every later section number by one. Some heading wording also differs (e.g. s26, s60).

Tax Map cites the Federal Government Printer gazette copy (`NTA-2025-gazette-fgp.pdf`, 202 sections, matching its own table of contents). To parse the LIRS copy instead for comparison, run `scripts/parse_acts.py` with `TAXMAP_NTA_COPY=lirs`.

## Taxes and Levies (Approved List for Collection) Act, 1998

The Act's five sections are in `sections.json` (`act_id` `TLA-1998`, tier `federal`). Its Schedule is in `levies.json`, one record per listed item (`item_id` such as `TLA-1998-sch-III-20`): Part I (8 items, collected by the Federal Government), Part II (11 items, the State Government) and Part III (20 items, the local government), as s. 1(1) assigns them.

- **Still in force.** None of the four 2025 Acts repeals it: the repeal provisions (Nigeria Tax Act 2025, s. 195 and s. 196; Nigeria Tax Administration Act 2025, s. 146) do not list it.
- **1998 Schedule only.** The Taxes and Levies (Approved List for Collection) Act (Amendment) Order 2015 was set aside by a Federal High Court judgment in 2020. Nothing from that Order is included.
- **What it is used for.** The Schedule says which tier may collect each tax or levy. Tax Map says only that an authority may collect a named levy. It never states a rate or amount from this Act. The Part II figures are 1998 maxima and may have been replaced by State law. The full item text, figures included, is shown when the law is opened.
