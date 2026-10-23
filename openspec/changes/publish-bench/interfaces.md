# Interfaces — publish-bench

## Владение
- P01: `skills/nullform/**`, `.claude/skills/nullform/**`,
  `.agents/skills/nullform/**`, `skills-lock.json`, `README.md`
  (install-секция), `tools/tests/p-publish.test.mjs`. Parent: openspec/.
- P02: `tools/measure-session.mjs` (new), `docs/benchmark-live.md` (new),
  `tools/tests/p-bench.test.mjs` (new). Читает `.workflow/`, не пишет.

## Границы
| Граница | Контракт |
|---------|----------|
| skills.sh layout | `skills/<name>/SKILL.md` + `skills-lock.json` (version 1, source/sourceType/skillPath/computedHash SHA-256) |
| mirrors | `.claude/skills/nullform/` и `.agents/skills/nullform/` — байт-в-байт копии skills/nullform/ |
| measure-session вход | `.workflow/state.json` + `metrics.jsonl` + usage-снапшоты; выход `{roles{}, total, wallMs, activeMs, tests}` |
| benchmark-live | таблица A-vs-N: units total/role-shares, minutes, tests, repairs; caveats честно |

## Сигнатуры
- `measureSession(root, {usageLog}) -> {roles, total, wallMs, activeMs, tests, ms}`.
- install-sim: `node tools/skills-doctor.mjs --agents-home <tmp> --repo <root>` (существующий CLI, проверить флаги).
