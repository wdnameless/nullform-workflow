# Recon: мультихарнес + самообновление (T3 Wave 1)

## Внешний аудит: alvinunreal/oh-my-opencode-slim (агент SlimRepoProbe, полный отчёт agent://SlimRepoProbe/report)
- TS-монолит (~700 файлов): агенты = TS-фабрики (не .md), 8 bundled скиллов (frontmatter только name+description), 6 slash-команд, 16 lifecycle-хуков.
- Их минимализм = минимализм токен-следа харнеса (in-process регистрация, zero-copy, cache-safe-injection с property-тестами), наш = минимализм кода при тяжёлой внешней верификации (40+ tools/*.mjs, sync двух деревьев, OpenSpec-гейты).
- Наше лучше и не трогаем: Blind Oracle, review-evidence.json с хешами, Stage B, debt-ledger, replay, run-skill-benefit-eval.
- Топ-5 заимствований: (1) фоновый staged self-updater с каналом/major-гейтом и кросс-процессным локом → tools/self-update.mjs; (2) Host Adapter shim + acp_run мост → tools/harness-adapter.mjs + core/PORTABLE.md; (3) cache-safe-injection runtime-протокол → agent/extensions + cache-policy; (4) Pinned Router Head ≤12 строк + tombstone → skills/deepwork + workflow.mjs; (5) tool-loop-guard + absolute-path-rescue + keyword-gated council → agent/extensions/.

## Форматы харнесов (агент HarnessFormatsProbe, проверено 2026-10-09, полный отчёт agent://HarnessFormatsProbe/report)
- SKILL.md (name+description) — межхарнесный лингва-франка: openclaw, hermes, openhuman, opencode, claude, omp.
- MCP-ключи фрагментированы: openclaw `mcp.servers` (JSON), hermes `mcp_servers` (YAML), claude/cursor/codex `mcpServers`, opencode `mcp`.
- AGENTS.md — де-факто стандарт инструкций везде; openclaw дополнительно хочет SOUL.md.
- openclaw: движущаяся мишень (схемы v2026.x). hermes (NousResearch): spec-стабилен (CLI v0.2.x). tinyhumansai/openhuman: semi-стабилен (Rust-рефакторинг, симлинки запрещены).
- OpenHumans Foundation / snowsadh/openhumans — НЕ харнесы; пользователь выбрал tinyhumansai/openhuman (Wave 0).

## Шов установки/синка (агент InstallSeamProbe, полный отчёт agent://InstallSeamProbe/report)
- Адаптеры в tools/install-harness.mjs: SUPPORTED_HARNESSES (:46), getDefaultRoot switch (:65-80), detectHarness (:53-63), install switch (:397-593), help (:627), тест-regex (:389 в тесте). Шов = 7 точек.
- Self-update отсутствует полностью: нет package.json, версий релизов, каналов, checksum. Единственная инструкция: install.ps1:33 «re-run after git pull».
- Топ-3 риска: sync --deploy затирает live без бэкапа (:466-474); install.ps1:320 безусловно перезаписывает models.yml; installSkills без 3-way merge + prompt-cache инвалидация без auto re-baseline.

## Файлы под изменение (предварительно)
- tools/install-harness.mjs + tools/tests/install-harness.test.mjs (адаптеры openclaw/hermes/openhuman + detect + help).
- README.md (промпт установки с детектом).
- agent/plugins.json? нет — версионирование: новый VERSION/релиз-тег + tools/self-update.mjs (check) + doctor-интеграция.
- CONTEXT.md (новые термины: adapter, channel, release).

## Acceptance check
- `node tools/install-harness.mjs --harness <openclaw|hermes|openhuman> --root <tmp> --dry-run --json` exit 0 + корректные пути из отчёта форматов.
- README-промпт: агент по нему детектит харнес и ставит туда (ручная проверка oracle на 1 харнесе).
- `node tools/self-update.mjs check` показывает drift от GitHub-релиза; `update` — одна команда после уведомления.
