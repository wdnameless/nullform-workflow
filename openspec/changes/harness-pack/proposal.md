# Harness-agnostic install packs

## Why

`install-harness` supports 8 ecosystems, but every unit of value ships through
hand-written per-harness adapter branches plus an npm `files` allowlist. There is no
portable unit a *foreign* harness (or a future one) can integrate by itself: no
manifested module list, no integration instructions, no post-install verification
contract. The video's dark-factory scheme (segment 8:53–13:45, recon
`.tmp/recon-dark-factory-video.md`) is exactly that triple: modules + instructions +
tests, integrated and verified by the receiving side.

## What Changes

- New unit: a **harness pack** directory — `pack.json` manifest, `modules/` payload,
  `INSTALL.md` instructions, `tests/` verification.
- New command `nullform pack install <pack> --harness <name> --root <dir>`
  reusing the existing adapter context, deployment journal/lock, path confinement,
  and doctor checks. Trust model stays ours: allow-list + journal + verify, never
  free self-modification.
- No changes to existing adapters' behavior; no new dependencies.
