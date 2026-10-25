# scripts/dev

Probes and checks used while building Tax Map. They are not part of the app, the tests or the submission flow, and nothing imports them. They are kept so the findings behind some design choices can be reproduced.

| Script | Live? | What it shows |
| --- | --- | --- |
| `_check_s22.ts` | yes (Critic calls) | The Critic's verdict on the VAT-return claim against the full text of NTAA-2025 s. 22. |
| `_probe_critic.ts` | yes (Critic calls, no retries) | Which variants of the s. 22 input Nightshift answers, and how long each takes. This is where the long-input and chunk-fallback findings came from. |
| `_checklist_check.ts` | no | The Parts of the Map of the Acts that each checklist area points to, for the sample profile. |
| `_glossary_check.ts` | no | Glossary size per interpretation section, and the definitions matched for the VAT-return claim. |
| `_glossary_match.ts` | no | Which definitions the glossary attaches for a few real claims. |

Run any of them with `npx tsx scripts/dev/<name>.ts`. The live ones need a filled-in `.env` and make real model calls.
