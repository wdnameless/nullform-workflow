# fcc-adopt-1267 — interfaces

## T1: probe+report (owner: @fixer)

- NEW `tools/harness-probe.mjs`:
  - `probeHarness(entry, runner = defaultRunner)` → `{installed: bool,
    version: string|null, status: available|not_installed|failed|timeout|
    unrecognized_version|unavailable}`. entry: `{id, detect:{cmd},
    versions?:{min, args[]}}`. runner инъектируется: `(cmd, args) →
    {status, stdout, stderr}` (default: spawnSync 5s, DEVNULL stdin).
  - `satisfiesMin(version, min)` — semver-тройка, без deps.
  - Версия: первый `\d+\.\d+\.\d+` из stdout+stderr.
  - COCO ≤15, функции ≤120 строк.
- `bin/nullform.mjs` doctor path ONLY: флаг `--report` (parseCliArgs +
  runDoctorCommand): печатает stdout JSON `{...enriched, report:
  {pkgVersion, system:{platform,arch,node}, harnessProbes:
  [{id,installed,version,status}], configStatus}}`. Без секретов
  конструкцией (не включать env/keys/paths-with-values).
  Не трогать init/menu/wizard код.
- NEW `tools/tests/harness-probe.test.mjs`: injectable runner фикстуры
  (installed+version, not_installed, timeout, bad-version, min-check
  pass/fail); report snapshot: ключи present, секретов нет
  (негативный матчинг sk-/ghp_/BEGIN PRIVATE KEY).

## T2: matrix+vocab (owner: @sonic)

- `tools/harness-matrix.json`: всем entries с detect.cmd добавить
  `versions: {min, args:["--version"]}` (min: hermes 0.20.4, остальные
  "0.0.0" = unknown-floor + note? НЕТ — только где факт известен:
  hermes; остальным versions опустить, loader толерантен).
  hermes: +`notes: ["HERMES_MANAGED_DIR overlay (FCC hermes.py)",
  "source: free-claude-code cli/launchers/hermes.py"]`.
  codex: +`notes: ["native catalog path (FCC codex_model_catalog.py)",
  "source: free-claude-code harnesses/codex_model_catalog.py"]`.
  JSON валиден, menu строится (filter _comment untouched).
- `CONTEXT.md` Engineering disciplines: +`- **Effort** — reasoning depth
  vocabulary: none|low|medium|high|xhigh|max (default medium).`
- `agent/models.yml.example`: раскомментировать efforts каноном:
  `efforts: [none, low, medium, high, xhigh, max]`, defaultLevel medium.
- `tools/tests/init-wizard.test.mjs` matrix-schema тест: +assert versions
  опциональны, hermes min 0.20.4, notes-массив. Только этот тест.
