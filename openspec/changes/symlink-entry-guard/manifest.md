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

## Deferred (explicit)

- Nothing dropped. The macOS CI leg is the acceptance gate for R43.
