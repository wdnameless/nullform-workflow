# fcc-adopt-1267 — proposal

## Why
T1-разбор free-claude-code (64.6k★, AGPL) дал 8 переносимых clean-room идей;
пользователь выбрал слайс 1+2+6+7: версии в матрице, doctor-репорт, словарь
effort, факты совместимости. Всё маленькое, zero-dep, разблокирует fallback-
цепочки и provider-catalog следующим ченджем.

## What Changes
- **Matrix versions (R01)**: entries получают опциональные
  `versions: {min, args[]}` + `activation: {args[], expect?}`;
  новый `tools/harness-probe.mjs` (`probeHarness(entry, runner?)` →
  {installed, version, status}, semver-min без deps, 5s timeout).
- **Doctor report (R02)**: `nullform doctor --report` печатает stdout JSON:
  enriched + {fccVersion→pkgVersion, system, harnessProbes[], configStatus};
  секреты исключены конструкцией (только версии/статусы/пути без значений).
- **Effort vocab (R03)**: CONTEXT term `Effort` (none/low/medium/high/xhigh/
  max, default medium); models.yml.example efforts раскомментированы каноном.
- **Compat facts (R04)**: hermes entry (min 0.20.4, MANAGED_DIR note),
  codex entry (catalog note), оба `source: FCC <file>`.

## QA-план
Контракты: (1) `openspec validate fcc-adopt-1267 --strict` exit 0;
(2) matrix остаётся валидным JSON, menu строится; (3) гейты зелёные.
Чёрный ящик: `doctor --report` на машине без харнессов → все
not_installed, exit 0; с моком spawn → версии парсятся.
Меняется в тестах: +harness-probe.test.mjs (injectable runner),
schema-тест +versions/activation, report snapshot без секретов.

## Non-Goals
- Копирование кода FCC (AGPL) — только реимплементация.
- Clipboard (кроссплатформенность тянет deps).
- Fallback-цепочки, provider-catalog, uninstall-cleanup (следующий чендж).
- Live-проверки провайдеров в report (только локальные probes).
