# Skill Parity & Source of Truth

This document defines the source of truth between repository and installed skills, and operator actions when `sync --check` reports drift.

## 1. Source of Truth

- **Canonical Repository (`<repo>/skills/`)**: The authoritative source of truth. All skill definitions, contracts, and prompt templates originate here.
- **Installed Runtime Copy (`~/.agents/skills/`)**: A local projection of the repository skills with host path placeholders (`<HARNESS>`) substituted on deployment.

## 2. Parity Statuses (`sync --check`)

`node tools/sync.mjs --check` verifies health via `skills-doctor.mjs`:
- **`VERIFIED`**: Installed skills match canonical repo templates byte-for-byte (after `<HARNESS>` normalization). No orphans, no truncations.
- **`DRIFT`**: Differences detected between installed skills and repo skills, truncated copies found, or repo skills missing from installed catalogue.
- **`NOT_APPLICABLE`**: Minimal/adaptive installation mode without a global catalogue.
- **`UNVERIFIED`**: Comparison repository not found or contains zero skills.

## 3. Operator Actions on Parity Drift

When `sync --check` reports `[XX] DRIFT`:
1. **Deploy Repository Changes (Default)**:
   When skills in the repository have been updated or added, push canonical versions to the live runtime:
   ```bash
   node tools/sync.mjs --deploy
   ```
2. **Promote Live Edits**:
   If skills were modified directly in the live environment and should update the repo:
   ```bash
   node tools/sync.mjs --promote
   ```
3. **Intentional Exclusions (No Pruning)**:
   Per R05, parity drift never triggers automated deletion or pruning of skills. If an installed skill is deliberately omitted by the operator, record its name in `<agents-home>/.skills-disabled.json` to exempt it from drift alerts.
