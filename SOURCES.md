# Sources

Statute text in `data/statutes/` is parsed from the PDFs below. The PDFs are not stored in this repo; they live in `C:\Users\LENOVO\Desktop\hackathon-scratch\acts\`. SHA-256 values are from each folder's `hashes.txt` and were re-checked against the files by `scripts/parse_acts.py`.

| act_id | Act | File | Folder | SHA-256 |
| --- | --- | --- | --- | --- |
| NTA-2025 | Nigeria Tax Act, 2025 | `NTA-2025-gazette-fgp.pdf` | `acts\gazette` | `41ABF6887BC58A3C97116FD9A048AA91AD49C1CAB156F39065A58401C0FCE94F` |
| NTAA-2025 | Nigeria Tax Administration Act, 2025 | `NTAA-2025-gazette-gng.pdf` | `acts\gazette` | `1602CF3245F250107E9BA0099C8755B52D04CD8A497A3C029772C624AB2C2625` |
| NRSEA-2025 | Nigeria Revenue Service (Establishment) Act, 2025 | `NRSA-2025-ctc.pdf` | `acts\ctc` | `B7072257F6D68DD99EC10F332FBDDB5FB507681B85172852A16510BFAFB87F0E` |
| JRBEA-2025 | Joint Revenue Board of Nigeria (Establishment) Act, 2025 | `JRBA-2025-ctc.pdf` | `acts\ctc` | `97B648230DEE2F6FC1E9F5248343DFB8D6C6D17B4C2D38ABE661ABEE6201E458` |

## Data sources

Two public copies of the Nigeria Tax Act exist and their texts differ. The LIRS copy (`NTA-2025-gazette-lirs.pdf`, SHA-256 `F15EDD3BC428D03FDDBAC7DAE9D5C7025C161BC02A04E42E3123975553965B91`) has 203 sections: it includes an extra s89 "Petroleum royalty" that the other copy lacks, which shifts every later section number by one. Some heading wording also differs (e.g. s26, s60).

Tax Map cites the Federal Government Printer gazette copy (`NTA-2025-gazette-fgp.pdf`, 202 sections, matching its own table of contents). To parse the LIRS copy instead for comparison, run `scripts/parse_acts.py` with `TAXMAP_NTA_COPY=lirs`.
