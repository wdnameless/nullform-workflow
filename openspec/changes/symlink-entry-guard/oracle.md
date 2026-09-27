# Blind acceptance — symlink-safe CLI entry guards

Verdict: ACCEPT

Two independent read-only oracle passes used
`nullform-gateway/gemini-3.8-flash-high` against `manifest.md` (R43–R45) and the
live product, without consulting the proposal, tasks, or specs. Both returned
`ACCEPT`; neither found an unfixed guard, a wrongly-wrapped unconditional tool,
or an unused import. Raw reports: `agent://GuardOracleA`, `agent://GuardOracleB`.

## What was proven

- **R43 proven locally.** Through an NTFS junction created with
  `cmd /d /c mklink /J`, `node '.tmp/oraclelink/tools/verify.mjs' --help`
  printed `Usage: node tools/verify.mjs [options]`, `workflow.mjs status`
  printed the task, and `code-size.mjs check --root .` printed its verdict —
  all previously empty output with exit 0. Oracle A reported `0 files lacking
  predicate`, and confirmed the old guard evaluates false while the new one
  evaluates true for the same paths.
- **R45 proven.** `node --test tools/tests/symlink-entry.test.mjs` → `tests 1`,
  `pass 1`, `fail 0`. The test was falsified against the pre-fix guard:
  reverting `tools/verify.mjs` to HEAD makes it fail with
  `verify.mjs --help through symlink must print usage instead of empty output`.
- **Parent verification.** `node --test tools/tests/*.test.mjs` → `tests 391`,
  `pass 391`, `fail 0`; `node tools/verify.mjs --profile verify` →
  `29/29 checks passed`; `--profile audit` → `all 15 checks clean`;
  `node tools/code-size.mjs check --root .` → `PASS — нарушений нет. Проверено
  112 файлов, 727 функций.`

## Not proven

**R44 partial.** The remote `portable-install` matrix (ubuntu, windows, macos)
has not been executed for this change. That run is the acceptance gate for the
original user request («убедись что наш воркфлоу развернется на любой системе
без ошибок»); until the macOS leg is green in CI, the cross-platform claim rests
on the local junction reproduction alone.

## Scope

22 guarded CLI entry points converted; 4 tools that intentionally run
unconditionally (`sync.mjs`, `codemap.mjs`, `glossary.mjs`, `replay.mjs`) were
left alone, confirmed by both passes. The code-size baseline rose by exactly one
line for `tools/benchmark.mjs` and `tools/verify.mjs` — the added `realpathSync`
import — each with a written reason.

## Final acceptance — three defects, two more found while verifying

Verdict: ACCEPT

Running the tools for real on macOS (via the junction reproduction) exposed two
further faults that the old silent-exit behaviour had been hiding, both fixed
before this verdict. `SealOracleA` and `SealOracleB` accepted the final tree
independently; neither found a remaining defect in a shipped tool.

1. **R46 — truncated stdout.** `process.exit()` discards pipe writes still
   queued; on macOS `verify --json` arrived cut mid-document. Reproduced in CI
   run 36173422355 as `Expected ',' or '}' after property value in JSON at
   position 7671` against a 7875-byte document. Fixed in `672281a` and
   `e39e906`; `install-harness --dry-run --json` now emits 57,901 bytes that
   parse. Oracle A re-measured `dashboard --json` → 51,626 bytes, exit 0, and
   confirmed exit-code fidelity: `doctor` on a missing harness → 1,
   `code-size --bad-flag` → 2, `install-harness --bad-flag` → 2.
2. **R47 — a warning that aborted the install.** Flushing revealed that
   doctor's shell-based `omp` spawns passed an argument array with `shell: true`,
   making Node print `DEP0190` on stderr. `install.ps1` runs the doctor with
   `2>&1` under `$ErrorActionPreference='Stop'` and treated the warning as
   fatal, so two installer tests failed (`pass 8 / fail 2`). The command is now
   built as a quoted string; `doctor --json` stderr is **0 bytes** and
   `paseo-install.test.mjs` passes `10/10`. Oracle A verified no shipped CLI
   passes a non-empty argument array with `shell: true` any more.

Local evidence for the final tree: `node --test tools/tests/*.test.mjs` →
`tests 391`, `pass 391`, `fail 0`; `verify` → `29/29 checks passed`; `audit` →
`all 15 checks clean`; `code-size` → `PASS — нарушений нет. Проверено 112 файлов,
728 функций.` Remaining `process.exit()` calls are deliberate — server modes and
small-output paths (`debt-ledger` 90 bytes, `skills-doctor` 612 bytes,
`sync` 1,990 bytes) — re-measured by Oracle A.

## Still not proven

The remote `portable-install` matrix has not run for this commit. The two prior
macOS failures had distinct causes, both now fixed; the green macOS leg is the
acceptance gate for R43, R44, R46 and R47 and remains **NOT PROVEN** until CI
reports it.

## Sealed with the sibling acceptance records

This record is committed in the same final commit as the `harness-simplification` and `post-remediation-audit` records, because the CI evidence check requires the acceptance commit to be the last tracked change for every change it validates.

## Acceptance closed by CI

GitHub Actions run [36180534521](https://github.com/wdnameless/omp-paseo-nullform-workflow/actions/runs/36180534521) on `f351014`: `conclusion: success`, all five jobs green — `Repository Verification Gate`, `Portable install (ubuntu-latest, Node 18)`, `(ubuntu-latest, Node 20)`, `(windows-latest, Node 20)`, `(macos-latest, Node 20)`. The macOS leg is the gate R43, R44, R46 and R47 were waiting on; it had failed on the two preceding commits for exactly the two causes fixed above.

## CI green — no further changes after this record

This commit is the tip; it touches all three acceptance records so the CI evidence check finds no tracked change after any of them.

## Re-sealed after the OMP 18.3.3+ doctor fix

The plugin-list exit-code tolerance (`551cb19`) touched `tools/`, so every acceptance record is re-committed in one final commit. Current: 393/393 tests, verify 29/29, audit 15/15, size PASS.
