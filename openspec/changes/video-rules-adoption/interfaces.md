# video-rules-adoption — interfaces

## T1: CI gates (owner: @fixer)

- repo-gate.yml job `gate`: новый шаг `Mutation gate` ПОСЛЕ `Run unit &
  regression tests`: определяет changed `*.mjs` (git diff против base),
  для каждого запускает `node tools/mutation-test.mjs --target <f>
  --cmd "node --test <suite>" --max-mutants <N> --check
  --threshold <T>`; N/T фиксированы в шаге (старт: N=10, T=80).
  Wrapper-скрипт допустим только если однострочник нечитаем.
- Новый шаг `Security audit`: `npm audit --audit-level=high` (+ osv-scan,
  если ставится одной командой); semgrep — только при zero-config JS.
  Fail = high/critical findings. Install-шаги `--no-audit` не трогать.
- Не менять: имена существующих шагов, порядок остальных гейтов.

## T2: protocol docs (owner: @sonic)

- PORTABLE.md Wave 1: +шаг `enrich-дамп` (инженер выгружает подводные
  камни/план реализации ДО research; фиксируется в manifest Constraints).
- PORTABLE.md Wave 2: +обязательная секция `## QA-план` в proposal.md
  (контракты, чёрный ящик, что меняется в тестах).
- manifest: поле `criticality: core|supporting|generic` отдельным блоком
  (НЕ колонка R##-таблицы — парсер requirements.mjs не меняется).
- oracle.md: калибровка — core: полный Evidence Protocol + запуск
  продукта; supporting: выборочные R## + гейты; generic: просмотр при
  зелёных гейтах. Без criticality в manifest = трактовать как core.
- orchestrator.md + skill: перед Wave 3 — `workflow ask design --note`
  + ask-виджет подтверждения; фан-аут только после `answered`.

## T3: CLI + manifest (owner: @fixer)

- `WAIT_KINDS` (workflow.mjs:1511): +`"design"`. `cmdAsk`/`cmdAnswered`
  без смены сигнатур. Никаких новых команд.
- `validateManifestRows` (workflow.mjs:997-1014): criticality-блок вне
  таблицы игнорируется (не ломает R##-парсинг); тест: manifest с блоком
  валиден, без блока валиден.
- sync-manifest.json: +`{"rel": "tools/brief.mjs"}` (соседи по алфавиту —
  сверить формат записей).
- NEW tools/tests/sync-manifest-coverage.test.mjs: парсит относительные
  `import ... from "./x"` в tools/dashboard.mjs и требует каждый файл в
  sync-manifest.json. Без сети, быстрый.

## T4: reviewer KB (owner: @sonic)

- reviewer.md `<boundaries>`: +обязанность сверить изменение с
  CONTEXT.md (термины) и interfaces.md активного ченджа (границы);
  findings без ссылки на БЗ/контракт = недействительны, вердикт
  помечается NEEDS_KB. Формат findings не меняется.
