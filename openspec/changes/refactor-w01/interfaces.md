# Interfaces — refactor-w01

## Владение (зоны disjoint)
- G01: `skills/biblicism-extractor/` (rm), `skills/frontend-design*/`,
  `skills/industrial-brutalist*/` (mv), мёртвые export в
  `tools/benchmark.mjs`, `tools/oracle-model.mjs`, `tools/usage-audit.mjs`,
  `tools/return-contract.mjs` + их тесты, `.tmp/worktrees/` (только 15
  merged-clean через git worktree remove).
- T01: `tools/code-size.mjs` (maskJsCode only), `tools/dashboard.mjs`
  (только esc allow-строка), `tools/quality-evidence.mjs` (live-ledger
  ветка) + `tools/tests/code-size.test.mjs`, `quality-evidence.test.mjs`.
- Parent: openspec/, .workflow/, мерж, полный сьют, oracle.

## Границы
| Граница | Контракт |
|---------|----------|
| skill rename | `git mv` директории; declared name в SKILL.md не меняется (уже правильный) |
| unexport | символ исчезает из ESM-экспорта; CLI-поведение идентично; тесты через CLI/фасад |
| worktree rm | только `git worktree remove --force` для 15 из списка; список фиксирован в задаче |
| maskJsCode | сигнатура та же; `${}` → push/pop; out без фальшивых скобок |
| live-ledger | дрейф count → `{status: warn/skip, note}` вместо throw; снапшот-путь без изменений |

## Сигнатуры
- Без новых публичных API. Удаляемые экспорты перечислены в задаче G01.
