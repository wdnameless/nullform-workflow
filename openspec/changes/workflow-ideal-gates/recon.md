# Recon — подтверждённые точки отказа

Ветка `fix/workflow-ideal-gates` от master `a5cb4ec` (PR #5 merged). Единственный untracked — пользовательский `backups/`, вне скоупа.

Проверены изолированными repro на OS-temp (код репо не менялся):
- `deletePruneCandidates(harness, ['tools/victim.mjs'])` при junction `harness/tools → external` → `deleted`, жертва снаружи удалена.
- `check-ci --tier T2` при `oracle.md ACCEPT + evil.js` в одном коммите → exit 0.
- numstat для 5-МБ бинаря → `"-\t-\tbin/f.bin"`; для rename → `"0\t0\tsrc/ok.txt => lib-evil.txt"`.
- `install.ps1:187-211` пишет в цель до всяких guard; Node-инсталлер (`install-harness.mjs:388`) guard имеет.
- Dirty-check `workflow.mjs:1646-1648` — построчный сплит + подстрока `.workflow/`.

Затронутый код: `tools/sync-prune.mjs:171-197`, `tools/sync.mjs:239-277`, `tools/workflow.mjs:1411-1451,1658-1697`, `install.ps1:150-215`. Тесты: `tools/tests/sync-prune.test.mjs`, `sync.test.mjs`, `workflow-gate.test.mjs`, портальность инсталлера. Новых зависимостей и схем не нужно.

Acceptance: красные регрессии на каждый repro выше; родитель гоняет focused + full + verify/audit + smoke после интеграции, затем слепой Oracle.
