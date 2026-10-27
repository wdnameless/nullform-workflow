# Manifest — review-run on user-configured models, no OpenAI key

Source: user "Мы не должны использовать openai key мы должны использовать доступные ИИ или которые задаст пользователь в конфиге" (2026-10-27).

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | review-run must NOT require OPENAI_API_KEY | "Мы не должны использовать openai key" | open |
| R02 | review-run must use available AIs (models resolvable in this environment) | "мы должны использовать доступные ИИ" | open |
| R03 | review-run must use models the user sets in config (models.yml / admission-policy) | "или которые задаст пользователь в конфиге" | open |
| R04 | Existing monetary safety stays: budget ceiling, reservation, held unknown spend, no silent dispatch | implied by budget.mjs design (must-not-break) | open |

## Constraints (recon facts)

- C1: `validatePolicy` admits exactly 2 routes (openai-pinned, nullform-gateway); everything else throws. The fix is a THIRD route, not removing the allowlist.
- C2: Precedent exists: gateway route already carries a non-OpenAI model (gemini) + custom endpoint + tariffs from policy.
- C3: `oracle-model.mjs` already resolves models from models.yml (`resolveOracleModel`) — R02/R03 reuse it, not a new discovery.
- C4: Credential env var must come from the policy (named by user), never hardcoded to OPENAI_API_KEY.
- C5: Docs (orchestrator.md, PORTABLE.md §review, nullform-workflow-full SKILL.md) + CONTEXT.md Review-execution term + 5 test files reference the pinned OpenAI model — all must move together.

## Acceptance (observable)

- A1: `review-run --dry-run` with a user-configured policy (custom provider/model/endpoint/tariffs, no OPENAI_API_KEY in env) validates and shows the route — no "OPENAI_API_KEY required" error.
- A2: Existing tests pass with fixtures (no live key needed); pinned-OpenAI fixtures replaced by user-configured fixtures.
- A3: No `OPENAI_API_KEY`-required path remains in review-run dispatch (grep proves: only redaction helpers + legacy test env names, no dispatch gate).
- A4: All existing gates green (code-size, clone, eslint, quality=3 foreign).
