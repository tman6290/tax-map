# Tax Map agent rules

- Use TypeScript with `strict` enabled; no `any` without a reason.
- Every external call (HTTP, LLM, database) must have a timeout and bounded retries.
- Secrets come only from `.env` (see `.env.example`); never hard-code them.
- Never print or log secrets, tokens, or API keys.
- Write logs to `logs/` as JSONL (one JSON object per line).
- Tests live in `tests/` and run with `npm test` (vitest).
- Run `npm run build` and `npm test` before finishing a change.
- Never run `git push`.
