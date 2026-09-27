# Requirements — repair workflow risk audit

User requests, verbatim:

> «Фикси все через субагентов на gemini, так же обнови все библиотеки, проверь и запуш все в гит»
> «Продолжай»

Source findings: `openspec/changes/workflow-risk-audit/report.md`. `all` means the ten numbered findings and every repo-declared dependency, including plugin/MCP version pins, CI actions and Python requirements; global agent plugins and private config are not independently upgraded.

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «Фикси все» | `sync --promote --harness .` does not replace unrelated periods or corrupt prompt text. | in-spec |
| R02 | «Фикси все» | Deploy/check cover every installed enterprise-directive copy, not just agents-home. | in-spec |
| R03 | «Фикси все» | Node/POSIX OMP install writes both required rule copies and size baseline and starts a usable platform-native MCP command; installed-mode doctor and drift pass. | in-spec |
| R04 | «Фикси все» | PowerShell installer substitutes a supplied GitHub PAT and PostgreSQL URL or refuses incomplete configuration without leaking a credential. | in-spec |
| R05 | «Фикси все» | Installer rejects any `--root` that descends into its copied source tree before mutation; documented in-place `--root .` remains safe. | in-spec |
| R06 | «Фикси все» | Dashboard session keys cannot escape project runtime dir or overwrite a file outside the root. | in-spec |
| R07 | «Фикси все» | `--ensure`/`--url` honor explicit session; incompatible sessions never adopt the same server, while same-session reuse remains idempotent. | in-spec |
| R08 | «Фикси все» | CI T1 requires recon evidence, T3 worktree evidence, and guarded-auto enforces allowed paths and measured diff cap without caller-supplied counts. | in-spec |
| R09 | «Фикси все» | All oracle verdict files count; a REJECT blocks CI. Tracked credential-named source changes invalidate local acceptance without reading secret content; git errors cannot turn stale acceptance green. | in-spec |
| R10 | «Фикси все» | Local T2 and CI demand matching artifacts; unrelated target-branch updates in a PR merge do not falsely invalidate acceptance. | in-spec |
| R11 | «обнови все библиотеки» | Inventory all repo-declared plugin/MCP/Python/CI dependency versions, update to supported current versions where available, keep pins reproducible, and report any package not safely upgradeable. | in-spec |
| R12 | «через субагентов на gemini» | Implementation is performed by explicit Gemini-model subagents on disjoint files in isolated worktrees; parent only owns specs/integration/git. | in-spec |
| R13 | «проверь» | Focused regressions, installed sandbox paths, full suite, size/sync/verify/audit and OS CI succeed with observed counts. | in-spec |
| R14 | «запуш все в гит» | Commit all deliverable changes (not user runtime data), push branch to origin and verify remote commit and CI. | in-spec |
