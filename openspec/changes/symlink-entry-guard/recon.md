# Recon — symlink-fragile CLI entry guards

## How this lane started

A T1 lane (`Push audited workflow and verify portable deployment on supported
systems`, user quote: «Запуш все в гит и убедись что наш воркфлоу развернется на
любой системе без ошибок») added a three-platform `portable-install` CI matrix
and a sandbox install test. The first matrix run failed on all four legs; after
one genuine test defect was fixed (blanket `verify` exit-0 assertion on a host
without `openspec`/`omp`), Linux and Windows went green and **macOS still
failed**. Diagnosis of that remaining failure produced a real product defect,
so the lane escalated to T2 (`--force --reason` recorded).

## The defect

`tools/verify.mjs` inside the macOS temp-dir sandbox wrote nothing to stdout, so
the test's `JSON.parse` threw `Unexpected end of JSON input`.

Reproduced on Windows with an NTFS junction:

| Command | Result |
|---|---|
| `node '.tmp/linkrepo/tools/verify.mjs' --help` | no output, exit 0 |
| `node 'tools/verify.mjs' --help` | usage text, exit 0 |
| `node --preserve-symlinks-main '.tmp/linkrepo/tools/verify.mjs' --help` | usage text, exit 0 |
| `node '.tmp/linkrepo/tools/code-size.mjs' check --root .` | no output, exit 0 |
| `node '.tmp/linkrepo/tools/workflow.mjs' status` | no output, exit 0 |
| `node '.tmp/linkrepo/tools/doctor.mjs' --harness . --json` | no output, exit 0 |
| `node '.tmp/linkrepo/tools/install-harness.mjs' --dry-run --harness claude --root .tmp/x` | no output, exit 0 |

The third row isolates the mechanism: `process.argv[1]` keeps the path as typed
while `import.meta.url` carries the real path Node resolved for the main module,
so `resolve(argv[1]) === resolve(fileURLToPath(import.meta.url))` is false and
`main()` never runs. `realpathSync` on both sides makes them equal (verified).

macOS is affected in normal use, not only in CI: `os.tmpdir()` is
`/var/folders/...`, a symlink to `/private/var/folders/...`, and both the
installer sandbox and the CI runner work there. `tools/workflow.mjs` — the tier
gate — is one of the affected files, so an installed macOS harness could accept
a task and enforce nothing while reporting success.

## Blast radius

Twenty-two guarded entry points (list in `interfaces.md`). Six already carry a
filename-suffix fallback and work; they are migrated for one governing rule.
`sync.mjs`, `codemap.mjs`, `glossary.mjs`, `replay.mjs` call their body at top
level and are unaffected.

## Acceptance check

Junction reproduction above turns green; a permanent regression test links to
the repo and asserts non-empty output; full suite, `verify`, `audit`, size gate
and the `portable-install` matrix stay green.
