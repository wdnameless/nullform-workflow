# Manifest — settle split and gate fixes

| ID | Requirement (verbatim user quote) | Evidence | Status |
|---|---|---|---|
| R01 | "даввай фиксить дефекты" | gate-crash false pass fixed in review-controlled-http.test.mjs; tamper test pins /REJECT verdict in/ | done |
| R02 | "даввай фиксить дефекты" | settle lifecycle in tools/workflow/settle.mjs; workflow-ci.mjs 1234 -> 995 lines | done |
| R03 | "даввай фиксить дефекты" | junction planted in .tmp/worktrees is not collected and outside data survives (probe) | done |
