# Полный аудит workflow-repo (2026-10-23, ветка feat/refactor-w4)

Метод: adversarial-code-review, режим audit. 2 слайса (quality: Careless
Colleague/Future Maintainer/Interaction Effects; security: Malicious
User/Ops/Data Integrity) + parent-верификация каждой Must/Should.
База: doctor 9/4/0 OK, code-size PASS (244 файла, 1609 функций),
debt 108/0, .tmp 1.2G/23 worktrees.

## Summary
Репозиторий здоров после волн w0–w4: все сплиты связаны, гейты зелёные.
Найдено 2 Must (безопасность), 5 Should, 4 Consider. Критичных регрессий нет.

### What's Done Well
- Сплиты w2–w4: 15 модулей, фасады экспортируют 100% API, циклы резолвятся,
  91 сьют покрывает функционал (AuditQuality).
- Host allowlist (loopback-only) + bind 127.0.0.1, DNS-rebinding отклоняется;
  /api/diff отдаёт только счётчики; save() atomic tmp+rename; lock O_EXCL
  с токеном; .gitignore покрывает секреты (AuditSecurity).

## Must Fix

### M1. redactSecrets пропускает распространённые форматы секретов
**Location:** `tools/brief.mjs:7-22`
**Lens:** Malicious User / Data Integrity
**Issue:** 7 regex покрывают connection strings, telegram, JWT, AKIA,
xox[abp], gh[pousr]_, sk-. Не покрыты: `github_pat_`, `glpat-`, `AIza`
(Google), `xoxr-`, `-----BEGIN ... PRIVATE KEY-----`, `Bearer <token>`,
`api_key=...`. sanitizeHttpState доверяет redactSecrets для feed/requirements.
**Impact:** Любой локальный процесс, читающий /api/state, забирает ключи
из текста ленты. Parent-подтверждено чтением brief.mjs.
**Suggestion:** Добавить 7 паттернов + тест с каждым форматом.

### M2. Ключи провайдера пишутся без ограничения прав
**Location:** `install.ps1` WriteText → models.yml/config.yml
**Lens:** Ops/On-Call
**Issue:** Нет ACL/chmod 600 на пути записи секретов. Grep по
chmod/icacls/Set-Acl/mode в install.* — пуст (parent-подтверждено).
**Impact:** На shared-хосте другие пользователи читают PROVIDER_API_KEY.
**Suggestion:** После записи: `icacls <file> /inheritance:r /grant:r
"$env:USERNAME:(R,W)"` (win) / `chmod 600` (posix).

## Should Fix

### S1. Мёртвые импорты в фасаде verify
**Location:** `tools/verify.mjs:14-19`
**Lens:** Future Maintainer
**Issue:** readFileSync/writeFileSync/readdirSync/mkdirSync/mkdtempSync/rmSync —
0 использований после сплита (parent: node-аудит, все по нулям).
runProc используется 1 раз — оставить.
**Impact:** Ложное впечатление ФС-активности фасада.

### S2. Висячие changes без оракула
**Location:** `openspec/changes/{dashboard-v2,cross-os,jev-automatic-assistance}/`
**Lens:** Interaction Effects
**Issue:** dashboard-v2/cross-os — стабы (2-3 файла, нет proposal/tasks);
jev-automatic-assistance полон, но без oracle-verdict.
validateCheckCiOracleFiles падает на них.
**Impact:** check-ci по этим changeId всегда красен.
**Suggestion:** Архивировать стабы, jev — довести до оракула или архива.

### S3. /api/diff читает через симлинки за root
**Location:** `tools/dashboard.mjs:636` openSync(join(absRoot,safe))
**Lens:** Malicious User
**Issue:** safe режет `..`, но нет realpath+containment (в отличие от
runtimePath). Симлинк в репо → line-count oracle вне root.
**Impact:** Низкий (только счётчики строк, не контент; нужен вредоносный репо).

### S4. Benchmark shell:true на данных задач
**Location:** `tools/benchmark.mjs:608,658,713`
**Lens:** Malicious User
**Issue:** setup/--cmd/checks задач выполняются через shell. Task YAML —
доверенная зона без явной границы.
**Impact:** Вредоносный task-файл = RCE при прогоне.
**Suggestion:** Документировать trust boundary или гейт --yes/allowlist.

### S5. state.json без symlink containment
**Location:** `tools/workflow.mjs:117` statePath
**Lens:** Data Integrity
**Issue:** Нет lstat/realpath-проверки: `.workflow → /elsewhere` уводит
lock+state за root. Сам lock (wx+token+stale) — хорош.
**Impact:** Нужен planted symlink (supply chain).

## Consider
- C1. `workflow.mjs:1088` parseSessionUsage — локальный split-парсинг;
  унифицировать на session-log.mjs (parent-подтверждено).
- C2. `.tmp/worktrees/`: 23 worktree (~1.2G) от закрытых волн; prune после
  проверки dirty (parent: temp_old_doctor.mjs 67K уже удалён).
- C3. sanitizeHttpState отдаёт layout файлов (branch/modules/arch) на loopback —
  принять как intended.
- C4. Skills/plugins без проверки подписи при install; skills-lock пинит
  только nullform. Detection есть, prevention нет.

## Non-issues (проверено, чисто)
- quality-evidence live-ledger: warn по дизайну (волна 1), тест покрывает.
- cost-snapshot JSONL: скаут ошибся, файла-дубликата нет (67 строк, только cost).
- Все 15 модулей сплитов: импорты/циклы/реэкспорты корректны.
- install.sh без curl|bash; install.ps1 с R06 repo-root guard.

## Accepted risks (C3/C4, recorded 2026-10-23)
- C3 ACCEPTED: sanitizeHttpState exposes repo layout (branch/modules/arch paths)
  on loopback /api/state. Intended: the dashboard UI needs it; listener is
  127.0.0.1-only with strict host allowlist. Revisit if the server ever binds wider.
- C4 ACCEPTED (with detection): skills/plugins execute on install without
  signature verification; skills-lock.json pins only `nullform`. Mitigations in
  place: skills-doctor parity/truncation checks, install from trusted repos only.
  Full signature verification is a follow-up feature, not a bugfix.
- S2 FOLLOW-UP: jev-automatic-assistance is a complete change awaiting a blind
  oracle run (T2 scope, needs its test evidence executed). Stubs dashboard-v2
  and cross-os were archived to openspec/changes/archive/.
