# Manifest — harness-agnostic install packs

| ID | Requirement (verbatim user quote) | Evidence | Status |
|---|---|---|---|
| R01 | "Давай сделаем такую же схему как у нее для того чтобы наш харнесс можно было ставить на разные экосистемы и тд" | pack format + `pack install` across the 8 supported harnesses | open |
| R02 | "продолжай" | proceed on preselected defaults: full format (not minimal), existing 8 targets, allow-list + journal + verify trust | open |
| R03 | video 11:50–12:20 "будет пакет с критическим набором модулей... и набор тестов, что должно получиться" | `pack.json` + `modules/` + `INSTALL.md` + `tests/` | open |
| R04 | video 12:09–12:20 "он это всё разворачивает... интегрирует... и потом смотрит на тесты" | install-then-verify flow with fail-closed exit codes | open |
