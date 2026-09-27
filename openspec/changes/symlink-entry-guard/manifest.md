# Requirements — symlink-safe CLI entry guards

User request (verbatim, in full):

> «Запуш все в гит и убедись что наш воркфлоу развернется на любой системе без ошибок»

Context: the deployment check for that request exposed a defect that makes the
claim false on macOS.

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R43 | «убедись что наш воркфлоу развернется на любой системе без ошибок» | Every shipped CLI invoked through a symlinked directory executes its command instead of silently exiting 0. Reproduced through an NTFS junction before the fix; reproduced on macOS in GitHub Actions run 36163571325 (job `Portable install (macos-latest, Node 20)`, `not ok 7 — Unexpected end of JSON input`). | in-spec |
| R44 | «без ошибок» | `node --test tools/tests/*.test.mjs` green, and the `portable-install` CI matrix (ubuntu/windows/macos) passes. | in-spec |
| R45 | «развернется на любой системе» | A permanent regression test creates a real directory symlink to the repo and asserts the guarded CLIs still produce output; it fails against the pre-fix guards. | in-spec |

## Evidence for R43

Invoked through a junction created with `cmd /d /c mklink /J`:

| Command | Before fix | After fix |
|---|---|---|
| `node '.tmp/linkrepo/tools/verify.mjs' --help` | no output, exit 0 | usage text |
| `node '.tmp/linkrepo/tools/workflow.mjs' status` | no output, exit 0 | task status |
| `node --preserve-symlinks-main '.tmp/linkrepo/tools/verify.mjs' --help` | usage text | usage text |

The third row isolates the cause: keeping the invoked path (`--preserve-symlinks-main`)
restores behaviour, so the guard — not the program — was wrong.

## Second and third defects, found while verifying R43

Fixing the guard made the tools run on macOS, which exposed two further faults
that the old silent-exit behaviour had been hiding.

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R46 | «убедись что наш воркфлоу развернется на любой системе без ошибок» | A tool that prints kilobytes of JSON and then exits must deliver the whole document. `process.exit()` discarded queued pipe writes; on macOS `verify --json` arrived cut mid-object (`Expected ',' or '}' after property value in JSON at position 7671` while the document is 7875 bytes). Reproduced in CI run 36173422355; the affected CLIs now set `process.exitCode` and flush. | done |
| R47 | «без ошибок» | `install.ps1` aborts the install when the doctor writes to stderr. The doctor's shell-based `omp` spawns passed an argument array with `shell: true`, making Node print `DEP0190` on stderr; while stdout was being discarded this stayed invisible. The command is now built as a quoted string, `doctor` stderr is empty, and the two installer tests pass. | done |

## Evidence

| Command | Before | After |
|---|---|---|
| `node tools/install-harness.mjs --dry-run --harness claude --root .tmp/x --json` | 60,977 bytes then `process.exit(0)` | 57,901 bytes, parses, exit 0 |
| `node tools/doctor.mjs --harness . --json` stderr | `[DEP0190] DeprecationWarning…` (1 line) | 0 bytes |
| `node --test tools/tests/paseo-install.test.mjs` | `pass 8 / fail 2` | `pass 10 / fail 0` |

## Deferred (explicit)

- Nothing dropped. The macOS CI leg is the acceptance gate for R43, R44, R46 and R47.
