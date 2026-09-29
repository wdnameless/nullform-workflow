# Interfaces and ownership

Без смены CLI/API. Один исполнитель (оркестратор сам, T0-правки + один writer при нужде).

| Consumer seam | Invariant | Owner paths | Requirements |
|---|---|---|---|
| `git ls-files` публичного трека | Нет `.db`, секретов, личных путей; openspec-история intact | `backups/`, `.gitignore`, доки | R01–R02 |
| README, install-адаптеры | Бренд NULLFORM WORKFLOW, EN+RU, короткие шаги | `README.md`, `install.ps1/sh`, `tools/install-harness.mjs` строки | R03–R04 |
| GitHub repo settings | public visibility; CI безлимит | API/веб, без файлов | R05 |
