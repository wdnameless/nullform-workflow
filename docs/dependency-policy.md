# Dependency Policy

This document defines dependency management, pinning standards, and update workflows for `nullform-workflow`.

## Inventory

| Category | Component / Package | Pinned Version / Mechanism | Purpose |
| --- | --- | --- | --- |
| npm (deps) | `json5`, `jsonc-parser`, `yaml` | Exact semver in `package.json` | Core parsing utilities |
| npm (devDeps) | `@eslint/js`, `eslint`, `globals`, `eslint-plugin-sonarjs` | Exact in `package-lock.json` | Strict linting suite + cognitive-complexity analyzer (`tools/quality.mjs`) |
| actions (5) | `actions/checkout` | `v7` | Unified repository checkout |
| actions (5) | `actions/setup-node` | `v4` | Node.js runtime setup |
| actions (5) | `actions/{upload,download}-artifact` | `v4` | Build artifact handoff |
| actions (5) | `crate-ci/typos` | `v1.51.1` | Source spell-checking |
| actions (5) | `agent-sh/agnix` | `v0.59.0` | Agent markdown linter |
| openspec | `@fission-ai/openspec` | `1.13.2` (`npx --yes` pin) | OpenSpec schema validation |
| actionlint | `rhysd/actionlint` | `v1.7.12` (release asset + SHA256) | Workflow syntax/shell checks |

Total managed pins: 7 npm packages + 5 action suites + OpenSpec + actionlint.

## Rules

1. **Pin Everything**: Floating tags (`@main`, `@latest`, unpinned npx) are strictly forbidden.
2. **Lockfile is the npm Pin**: `package-lock.json` is committed and enforced via `npm ci`.
3. **Weekly Dependabot Proposals**: Dependabot checks npm and GitHub Actions weekly, opening at most 5 PRs per ecosystem with prefix `chore(deps):`.
4. **Validation and Merging**: All PRs must pass `repo-gate`. Merges require human approval: `pr-triage` holds any PR lacking the `bugfix` label. Dependabot PRs do not carry `bugfix` and will never auto-merge.

## Why Not Renovate?

Managing 11 total pins (6 npm + 5 action suites) does not justify running a separate third-party service, hosted app, or self-hosted container. Dependabot is built natively into GitHub, requires zero external tokens or infrastructure, and fits our lean maintenance profile.

## How to Flip a Pin

1. **Edit**: Update the version tag in the target file (`package.json`, workflow YAML, or script). For npm, run `npm install <pkg>@<ver> --package-lock-only` to update `package-lock.json`.
2. **Verify Locally**: Run test and validation suites locally:
   - For npm / workflows: run `npm ci` and `node --test tools/tests/*.test.mjs`.
   - Validate YAML integrity: parse updated files with `yaml`.
3. **Submit PR with Evidence**: Fill out `.github/pull_request_template.md` with explicit before/after command outputs demonstrating clean checks across `repo-gate`.
