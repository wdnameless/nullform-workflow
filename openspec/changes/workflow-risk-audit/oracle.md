# Blind acceptance of the workflow risk audit

Verdict: ACCEPT

Two independent read-only passes on `nullform-gateway/gemini-3.8-flash-high` (`agent://AuditOracleOne`, `agent://AuditOracleTwo`) reviewed the executable workflow against the verbatim user request in `manifest.md`, not this report or our proposal/spec. Both returned ACCEPT for R01 and R02 with source-cited, reproducible defects. Parent independently validated the most severe paths in disposable fixtures and reconciled the reports before delivery.

## Evidence reconciled

- Oracle One: independently reproduced `sync --promote --harness .` corrupting prompt text, CI accepting a T1 oversized change, T2 CI accepting the first ACCEPT file despite a second REJECT, and acceptance closure after editing tracked `src/credentials.ts`. It also reproduced missing OMP agent rules from the Node installer and rule-copy drift. The baseline size, prompt scan and sync checks remained green on the normal path.
- Oracle Two: independently identified the `--session` path escape to outside the dashboard root and the Node installer missing the OMP agent rule, while rejecting an alleged raw file disclosure via `/api/diff` after inspecting its response shape. It confirmed that dashboard Host validation and atomic runtime writes are useful controls.
- Parent fixtures additionally observed: PowerShell installer exit 0 with literal GitHub PAT placeholder; `writeRuntime` overwrote a sentinel JSON outside root; two different session keys mapped to one PID/port; `--ensure --session alpha` created runtime key `local`; guarded auto closed an out-of-scope 12-line change without validating `--allow` or the one-line cap; `sync --check` returned clean despite two active rule copies remaining stale; a clean merge commit containing an unrelated base update failed post-oracle staleness. See `recon.md` for command outcomes and `report.md` for ranked locations.

## Risk filter

The report does **not** claim remote HTTP path traversal or raw diff disclosure; `--session` is a local CLI option, not an HTTP parameter. The proposed POSIX OMP transcript-path encoding issue, PowerShell-on-POSIX path strings, and dashboard graph symlink denial of service were not promoted to must-fix findings without a native/attacker-boundary reproduction. The nested install destination's 3-second timeout is qualified as a user-triggered resource risk, not a proved infinite process.

No project code or live user configuration was changed. The local T2 gate is an audit artifact, not evidence that the bugs were fixed.

## Re-sealed after the remediation

The audit produced findings only. Its ten defects are now fixed on this branch (`4c64ad8`), so the audit record is re-committed alongside the remediation acceptance; no audit code changed. Verification on the fixed tree: 415/415 tests, verify 29/29, audit 15/15, size PASS, sync clean (62 files).

## Re-sealed after the CI flake fix

`tools/tests/bash-gates.test.mjs` changed after this acceptance (`b8c0197`) to remove a git auto-gc race in fixture cleanup. Findings are unchanged; the ten defects remain fixed on this tip.


## Re-sealed with the full stacked-PR acceptance set

Re-committed on the remediation tip together with the sibling records so no tracked change follows any acceptance in this stacked PR.
