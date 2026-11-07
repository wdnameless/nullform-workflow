# release-130 — interfaces

## Analyzer install (owner: parent)
`tools/quality/stacks.json` python stack already pins
`pylint==4.1.3` + `pylint-cognitive-complexity==0.1.1` and declares
`install.requiresVenv: true`. No code change was needed; the venue is
`.venv` at the repository root, created with `python -m venv .venv`.

## Ignore contract
`.gitignore` now contains `.venv/`. `.quality/` stays ignored (machine-local
sidecar configs); `.quality-baseline.json` stays tracked (ratchet state).

## Packaging contract
`npm pack --pack-destination .tmp` produces
`.tmp/nullform-workflow-1.3.0.tgz` honoring `package.json#files`.
`tools/certify-package.mjs` compares every packed file hash against the repo and
refuses on mismatch, on a dirty tree, or on a missing certificate.

## Publication contract
`tools/publish-release.mjs` is fail-closed: it requires npm auth, certificates,
and independent acceptance. It prints each blocker; none may be bypassed by
editing the script.

## Ownership
Parent owns install, venv, tarball, and gate runs. npm login and publication are
the account owner's action; credentials never enter the repository or a prompt.
