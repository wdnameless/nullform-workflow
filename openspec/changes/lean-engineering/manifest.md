# Requirements — lean engineering: ladder + review tags + debt ledger (T2)

User: «этот подход у нас есть ? https://github.com/DietrichGebert/ponytail» · «Также проанализируй вот этот репозитории и сравни его с нашим воркфлоу. Что мы можем взять из него нам?» · «делай делай» (approval of the proposed P0+P1 scope: ladder + review format + debt-ledger with archmap integration; benchmark P2 explicitly deferred as a separate initiative).

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| R01 | Solution ladder in executing roles | `agent/agents/fixer.md` and `agent/agents/designer.md` carry the 7-rung ladder (need? → reuse → stdlib → native platform → installed dependency → one line → minimum) with: runs AFTER understanding, never-cut list (trust-boundary validation, data-loss error handling, security, accessibility, explicit requests), root-cause-before-edit for bug reports | in-spec |
| R02 | Tagged over-engineering review | `agent/agents/reviewer.md` lens: findings tagged `delete: / stdlib: / native: / yagni: / shrink:`, each naming its replacement; verdict carries `net: -N lines possible` or `Lean already.`; minimum smoke-check test never flagged; correctness findings unaffected | in-spec |
| R03 | Defer markers + debt ledger tool | Convention `defer: <what> \| ceiling: <limit> \| upgrade: <trigger>` in a single-line comment (prefixes `// # -- ; /* * <!--`); `tools/debt-ledger.mjs scan [--root] [--json] [--check] [--write <file>] [--marker <key>]`: groups markers by file, flags missing `upgrade:` as `no-trigger`, `--check` exits 1 on any no-trigger, never scans node_modules/.git/build output or markdown | in-spec |
| R04 | Debt ledger in archmap | `tools/archmap-problems.mjs` gains `detectDebtProblems`: category `maintainability`, kind `debt-no-trigger`, low severity, only for markers lacking a trigger; appears in `archmap json` and the HTML report via the existing generic path | in-spec |
| R05 | Docs and vocabulary | `CONTEXT.md` gains *Solution ladder*, *Defer marker*, *Debt ledger* (+ tooling entry); `README.md` documents the ladder, the marker grammar, the review tags and the CLI | in-spec |
| R06 | Harness wiring | `tools/sync.ps1` manifest ships the new tool; `tests/test-portability.ps1` asserts it installs; `tools/audit.ps1` presence check; `verify.ps1` proves the `--check` gate (fixture: no-trigger → exit 1, triggered → exit 0); CI keeps auto-discovering the new test file via `node --test tools/tests/*.test.mjs` | in-spec |
| R07 | No regressions | Existing node/py/portability suites stay green; prompt-lint baseline refreshed deliberately after the prompt edits; `sync` clean; `audit.ps1` green | in-spec |

Non-goals (stated): adopting the ponytail plugin itself (hooks/marketplaces/intensity levels) — different delivery architecture; the benchmark harness (P2, separate initiative); changing reviewer output schema; auto-fixing findings.

Assumptions (stated): marker keyword `defer` defaults to it but is overridable (`--marker`); comment-prefix requirement keeps prose out of the ledger; markdown excluded from scanning so this manifest cannot self-trigger.
