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
