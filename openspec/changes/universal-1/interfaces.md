# Interfaces — universal-1

## Владение (зоны слайсов, disjoint)
- A: `tools/install-detect.mjs` (new), `tools/doctor-lite.mjs` (new),
  `tools/install-harness.mjs` (additive), `tools/tests/u-install.test.mjs` (new).
- B: `tools/brief-rounds.mjs` (new), `tools/workflow.mjs` (cmdBrief only),
  `tools/tests/u-brief.test.mjs` (new).
- C: `tools/dashboard.mjs` (run-view waves only), `tools/benchmark-run.mjs` (new),
  `docs/benchmark.md` (new), `tools/tests/u-waves.test.mjs` (new).
- D: `skills/nullform/SKILL.md` (new), `tools/workflow.mjs` (check-ci gates only),
  `tools/tests/u-quality.test.mjs` (new). Конфликт зон B/D по workflow.mjs —
  разные функции (cmdBrief vs checkCi), мерж руками родителя.
- Parent: `openspec/changes/universal-1/*`, `.workflow/`, мерж веток.

## Границы
| Граница | Контракт |
|---------|----------|
| install-detect → install-harness | `detectInstall(home) -> {present, version, root, conflicts[]}`; conflicts: `{marker, path, advice}`; никакого удаления |
| doctor-lite → workflow start/check | `doctorLite(root) -> {ok, warns[], ms}`; ≤2000мс; только WARN, exit не меняет |
| brief-rounds → manifest | `runBriefRounds(brief, {rounds, ask}) -> addenda[]`; addenda append в `## Дополнения` + manifest G-строки |
| plan-check → dashboard waves | `run.waves: [{n, tickets:[{id, title, status, lines}]}]`; калибровка `linesPerTicket: 3000` |
| benchmark-run → docs | `runBenchmark(fixture) -> {roles{}, total, tests, ms}`; детерминирован на фикстуре |
| SKILL.md → skills-doctor | пакет валиден: name/description/version/allowed-tools |

## Сигнатуры
- `detectInstall(homeDir=".")`, `suggestUpgrade(cur, latest)`, `detectConflicts(root)`.
- `doctorLite(root)` — подмножество doctor.mjs без сети и тяжёлых smoke.
- `runBriefRounds(briefText, opts)`, `appendAddenda(manifestPath, rows)`.
- `collectWaves(root)` — из plan-check артефактов; `calibrationHint(lines)`.
- `runBenchmark(fixtureDir)` — синтетика, без платных вызовов.
