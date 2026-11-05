# adoption-program — proposal

## Why
Подтверждённый аудит нашёл деструктивный settle, неработающий positional API,
неверный install-smoke, гонку портов, семантические ошибки harness/experience
и registry drift. Upstream agent_skills предлагает полезные локальные
механизмы: scope classification, security/eval/registry contracts, worker
briefs, dependency diagnosis и bounded optimizer. Пользователь выбрал полный
план + optimizer, $10, candidate-only.

## What Changes
- Phase A: safe settle and real install smoke; eliminate port TOCTOU.
- Phase B: restore correct harness semantics; validate lesson content;
  clean registry and module/CLI/codemap coherence.
- Phase C: deterministic scope/skill/dependency tools and registry contracts;
  candidate-only optimizer with explicit live-provider limits.
- Phase D: executed cross-checks, final oracle and spend/evidence report.

## QA plan
Every bug: failing regression before fix, passing after. Safe git sandbox
for deletion behavior. Isolated install root/home. Focused suites per phase,
then full relevant suite. No changing failing tests to green. Blind oracle
against manifest R01–R12. Live model quality not claimed without paired A/B.

## Non-Goals
- No auto-apply prompt/skill changes.
- No new frontend/ADK/advisor runtime.
- No fake model success, no paid unapproved dispatch, no universal quality claim.
- No unrelated reformat or broad refactor.
