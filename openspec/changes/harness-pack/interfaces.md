# Interfaces — boundaries, signatures, owners

| module | public surface | owner |
|---|---|---|
| `tools/pack-format.mjs` (new) | `loadPack(dir): {manifest, files}` — parses and hash-verifies `pack.json` + `modules/`; throws on unlisted file or hash mismatch | pack format |
| `tools/pack-install.mjs` (new) | `installPack({packDir, harness, root, dryRun})` — resolves target paths through the adapter ctx, copies allow-listed modules via journal + lock, runs pack tests + doctor subset, returns receipt | installer |
| `tools/installation/adapters.mjs` | reused `applyHarnessAdapter(h, ctx)` target-path logic; no behavior change | install (existing) |
| `tools/installation/journal.mjs` | reused `acquireDeploymentLock`, `DeploymentJournal`, `safeAtomicWrite` | install (existing) |
| `bin/nullform.mjs` | new `pack install` subcommand wiring (parse → installPack → exit code) | CLI entry |

Boundaries that do not move: adapter branches keep their current behavior; the npm
`files` allowlist is untouched; trust stays allow-list + journal + verify (no free
self-modification of the receiving harness).
