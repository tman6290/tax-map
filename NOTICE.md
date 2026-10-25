# Notice

Tax Map is released under the MIT License (see LICENSE). This notice records the outside sources it relies on.

## Meterless engine specs

The H-MEM and World Model engines in `src/engines/` are implemented from scratch, using the Meterless H-MEM Agent Engine and World Model Agent Engine specifications as the design source. No Meterless code is included. The conformance suites in `tests/conformance/` are derived from those specifications' Implementation Checklists; no vendored suite exists. `npm run conformance` lists the checklist items outside the minimum build, which are not counted.

## Zetaris getting-started repository

The Zetaris getting-started repository was read for the SQL forms and API shapes used to register and query the statute tables. Nothing was copied from it.

## Statute texts

The statute text in `data/statutes/` is parsed from Nigerian legislation: the Nigeria Tax Act 2025, the Nigeria Tax Administration Act 2025, the Nigeria Revenue Service (Establishment) Act 2025, the Joint Revenue Board of Nigeria (Establishment) Act 2025, and the Taxes and Levies (Approved List for Collection) Act 1998. SOURCES.md lists the copies used and their SHA-256 hashes. The MIT License covers the code, not the law.
