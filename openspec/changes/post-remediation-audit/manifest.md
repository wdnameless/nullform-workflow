# Requirements — fix the post-remediation audit defects

User request (verbatim, in full):

> «чини»

The audit (`openspec/changes/post-remediation-audit/`) found 13 confirmed defects in the
post-remediation tree. This lane fixes them. Every finding is reproduced before the fix and
re-tested after.

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R30 | «чини» | `sync.mjs` — promote runs in two passes: collect all suspect files first, only then write. A refused multi-file promote leaves the repo untouched. Reproduced before and after. | done |
| R31 | «чини» | A missing `~/.omp/agent/AGENTS.md` is reported as drift, and `--deploy` restores it. Reproduced in a sandbox: missing file → `check` names it, `--deploy` writes it. | done |
| R32 | «чини» | The `liveRoot: "@agentdir"` token maps to `agentDir`, not to `harnessRoot`. Verified by reading the resolved path. | done |
| R33 | «чини» | An explicit `--repo` that fails validation exits 2, not a silent fallback to another repository. Reproduced with a nonexistent path. | done |
| R34 | «чини» | `sync.mjs --json` emits one parseable JSON document on stdout even on drift; diagnostic lines use stderr. Reproduced by parsing the separated streams. | done |
| R35 | «чини» | `tools/sync-manifest.json` includes the sync engine and its own manifest; the install doctor requires both, so missing engines cannot pass silently. | done |
| R36 | «чини» | A method with parameters split across lines or the brace on the next line is measured. A 200-line multiline method was flagged. | done |
| R37 | «чини» | A multiline template literal or block comment containing `function fakeFn() {` is NOT parsed as code. Regression tests exercise both. | done |
| R38 | «чини» | Two `code-size.mjs baseline` runs on identical code produce byte-identical output. Reproduced by comparing output files. | done |
| R39 | «чини» | Workflow start reports only a dashboard URL verified by the dashboard's `/api/health`. A stale runtime file naming a live PID and an unresponsive port was ignored; the printed URL answered health. | done |
| R40 | «чини» | `HOST_CONFIG` protects `agent/oracle-priority.json` and does not hide new `templates/ci/config.yml` or `tools/config.json` orphan candidates. Regression fixture exercises all three. | done |
| R41 | «чини» | `agent/agents/orchestrator.md` repeats the dashboard failure handling in `AGENTS.md`: if `browser_new_tab` cannot connect, give the user the URL without claiming it opened. | done |
| R42 | «чини» | Oracle network-evidence guidance uses runnable `node tools/replay.mjs replay --cassette <file> --strict` and `node tools/replay.mjs verify --cassette <file>` commands, rather than bare `replay --strict`. | done |

## Deferred (explicit)

- Nothing is dropped. Every defect from the audit is addressed by a fix, and each fix is
  measured against a real command, not a plan.
