# tools/installation/

## Responsibility
Transactional deployment layer for the harness: installs, updates and rolls back agent-harness configuration across 8 supported targets (`claude`, `codex`, `opencode`, `cursor`, `omp`, `openclaw`, `hermes`, `openhuman`). Owns three concerns and nothing else — host/profile resolution, crash-recoverable mutation (lock + journal + backup), and config-file surgery that preserves user content. It is the only layer allowed to write outside the repository.

## Design Patterns
- **Transaction / Unit-of-Work with Journal**: `journal.mjs` is the transaction manager — `acquireDeploymentLock` (exclusive, stale-owner detection via `isProcessAlive`) → per-entry `safeAtomicWrite` with pre-image backup → `DeploymentJournal` entries → on failure `restore.mjs`'s `restoreSingleEntry` replays pre-images. `recoverAbandonedJournal` runs at start-up to finish or undo a crashed deployment.
- **Repository / Identity Registry**: `state.mjs` holds installation identity — `getStateFilePath`, `readInstallationState` / `writeInstallationState`, `validateInstallationState` — plus SemVer primitives (`parseSemVer`, `compareSemVer`, `readLocalVersion`) and path safety (`validateSafePath`, `detectEffectivePrefix`, `resolveInstalledBinPath`).
- **Strategy per Adapter**: `adapters.mjs` exposes one entry per target family (`applyHarnessAdapter`, `applyOpencodeAdapter`, `installOmpHomeAssets`, `prepareHermesActivation`), each implementing the same preflight → mutate → journal contract.
- **Managed Block (Sentinel Merge)**: `config.mjs` injects/removes content between `MANAGED_START` / `MANAGED_END` markers so user edits outside the block survive; per-format preflights (`preflightJsonConfig`, `preflightJsoncConfig`, `preflightJson5Config`) validate before writing, and format-specific sanitized error messages keep secrets out of logs.
- **Declarative Capability Matrix**: `capabilities.mjs` maps presence → capability status (`getHostPresence`, `getCapabilitiesInfo`, `checkHarnessCapabilities`, `checkVersionAlignment`, `validateReviewCapability`) so callers ask "is it supported?" instead of probing ad hoc.
- **Policy Merge with Ownership Rules**: `hermes-policy.mjs` — `updateHermesConfigYaml` — validates YAML 1.1 native fields and rejects merge keys, touching only owned keys.

## Data & Control Flow
1. `profiles.mjs` resolves the host (`resolveHostHome`), validates its manifest (`validateHostManifest`) and inspects it (`inspectHarness`) — read-only.
2. `state.mjs` reads identity, validates the target path (`validateSafePath`) and computes the effective install prefix; `capabilities.mjs` gates the plan on detected capabilities and version alignment.
3. `journal.mjs` takes the deployment lock and opens a journal, then each adapter mutates its config through `config.mjs` (parse → preflight → managed-block rewrite → atomic write), recording a backup per entry.
4. Success → journal settled and lock released. Failure → `restore.mjs` reverts entries in reverse order, journal stays for diagnosis. Crash → `recoverAbandonedJournal` on next run.
5. Money/credentials never enter this layer: `sanitizeError` and the format-specific error helpers reduce thrown messages to safe text.

## Integration Points
- **Consumers**: `bin/nullform.mjs` (`init` wizard), `tools/install-harness.mjs`, `tools/harness-setup.mjs`, `tools/verify.mjs` / `tools/verify-profile.mjs`, `tools/sync.mjs` (managed-block and drift comparison).
- **Imports outward**: `../worktree-snapshot.mjs` (repo boundary + git-common discovery, used by `journal`, `state`, `profiles`, `restore`); `json5`, `jsonc-parser`, `yaml` are the only parser dependencies.
- **Exported symbols other layers depend on**: `safeAtomicWrite`, `acquireDeploymentLock` / `releaseDeploymentLock`, `DeploymentJournal`, `recoverAbandonedJournal`, `readInstallationState` / `writeInstallationState`, `resolveInstalledBinPath`, `validateSafePath`, `MANAGED_START` / `MANAGED_END`, `resolveOpencodeConfigPaths`, `updateHermesConfigYaml`.
- **On-disk artifacts**: installation state file, `deployment.lock`, deployment journal, deployment backup directory (paths resolved by `getDeploymentLockPath` / `getDeploymentJournalPath` / `getDeploymentBackupDir`, never hard-coded by callers).
- **Tests**: `tools/tests/install-harness.test.mjs`, `install-guard.test.mjs`, `install-skills-assets.test.mjs`, `native-setup-precedence.test.mjs` (all sandbox via `test-helpers.mjs`).
