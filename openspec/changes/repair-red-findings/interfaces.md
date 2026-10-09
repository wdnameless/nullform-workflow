# Interfaces: repair-red-findings

## Зоны (disjoint, по одному владельцу)
- A (тесты): tools/tests/delete-guard.test.mjs, tools/tests/jev-native-test-helpers.mjs (+ 2 JEV-теста только для skip-обёртки), tools/tests/paseo-install.test.mjs. Возможно tools/benchmark.mjs:426 рядом — нет, это зона C.
- B (CLI): tools/jev-evaluate.mjs, tools/jev-control.mjs, tools/cache-policy.mjs, tools/return-contract.mjs, tools/run-skill-benefit-eval.mjs, tools/skills-doctor.mjs (+ их тесты, если есть — иначе ручная проверка exit-кодов).
- C (чистка): CONTEXT.md, .gitignore, tools/benchmark.mjs (только TOOL_ARTIFACT_PATHS + python-путь), tools/worktree-snapshot.mjs, tools/sync-prune.mjs, agent/agents/fixer.md, skills/web-design-engineer/, skills/ui-ux-pro-max/, skills/ui-styling/.

## Контракты
- Никто не меняет чужую зону; общий файл tools/tests/benchmark.test.mjs никому не принадлежит в этом заходе (не трогать).
- Каждый фикс: было (падало/висело) → стало (зелень/exit) с командой.
- R04: единый паттерн --help → usage на stdout + exit 0, без побочных эффектов.
- R06: тело SKILL.md ≤500 строк, ссылки форматом [text](references/x.md), skill-audit без новых ошибок.
