# Proposal — symlink-safe CLI entry guards

## Problem

Installed on macOS, every shipped CLI exits 0 and does nothing.

The cause is a one-line idiom repeated across the tools. A module decides
whether it is the process entry point by comparing the path in
`process.argv[1]` with `import.meta.url`. Node resolves the *main* module to its
real path when it builds `import.meta.url`, but `process.argv[1]` keeps the path
as typed. When any parent directory is a symlink the two never match, `main()`
is never called, and the process ends successfully having done nothing.

macOS is not a corner case here: `os.tmpdir()` is `/var/folders/...`, which is a
symlink to `/private/var/folders/...`, and the installer uses exactly that
directory. A user following the documented install on a Mac gets a harness whose
tools silently no-op — including `tools/workflow.mjs`, the tier gate.

## Evidence

A GitHub Actions run of the new portability matrix failed on
`macos-latest` while Linux and Windows passed, with the sandbox verifier
producing empty stdout. The same symptom reproduces on Windows through an NTFS
junction, and disappears under `--preserve-symlinks-main`, which pins the cause
to the guard rather than to anything platform-specific in the tools.

## Change

Identify the entry point by filesystem identity: resolve both sides with
`realpathSync` before comparing, and treat an unresolvable path as "not the
entry point". Files that intentionally run unconditionally keep that behaviour.

## Acceptance

A permanent test creates a real directory link to the repository and asserts
that the guarded tools still produce their output through it. The test fails
against the current guards and passes after the change, and the three-platform
CI matrix goes green.

## Risk

Low. The predicate becomes strictly more permissive: it can only turn "not the
entry point" into "the entry point" for a path that resolves to the module
itself. Tool logic, arguments, and output are untouched.
