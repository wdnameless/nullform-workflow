# NULLFORM WORKFLOW

[![CI](https://github.com/wdnameless/nullform-workflow/actions/workflows/repo-gate.yml/badge.svg)](https://github.com/wdnameless/nullform-workflow/actions/workflows/repo-gate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Hard gates over promises. Verified tests over "done". Observability over guesswork.**
**Строгие гейты вместо обещаний. Проверенные тесты вместо «готово».**

Portable engineering harness for AI coding agents — 8 roles · 70 skills · 8 host adapters · Windows / Linux / macOS.

![Live Dashboard](docs/assets/dashboard-graph.jpg)

## Install

Requires Node.js `>=18.19.0`. *Release status: package is prepared for public npm release, currently unpublished on registry.*

```bash
npm install -g --ignore-scripts nullform-workflow
nullform init            # choose your harness: claude · codex · opencode · cursor · omp · openclaw · hermes · openhuman
nullform doctor          # verify installation health
nullform capabilities   # explicit 8 configuration adapters vs OMP-only automated review
nullform workflow <cmd> # execute core Node-native workflow gates directly
nullform evidence        # transparent comparative quality evidence
nullform update          # update via npm, no git needed
```

Private registries use npm's `.npmrc` authentication. `nullform update --dry-run` previews the upgrade.

Headless (Cursor rules are project-scoped):

```bash
nullform init --harness opencode --yes
nullform init --harness cursor --project-root . --yes
```

Developers: `git clone https://github.com/wdnameless/nullform-workflow.git && cd nullform-workflow && npm ci`.

## Work in tiers

```bash
nullform doctor
nullform workflow start --tier T1 --task "smoke check"
nullform workflow artifact --kind recon --detail "Files: chosen task files; acceptance: run the task smoke check before close."
nullform workflow close
```

| Tier | When | Gate |
|---|---|---|
| **T0** | 1–2 files, trivial fix | Tier declared → `close` |
| **T1** | 3+ files, unfamiliar area | Recon before edits, verify before `close` |
| **T2** | Architecture, new module | Manifest (`R##`) → OpenSpec → blind oracle ACCEPT |
| **T3** | Multi-feature program | T2 per slice |

## Why it works

- **Lane gates** — PRs and pushes to `main`/`master` validate tier artifacts; T1 requires committed recon, T2/T3 require current review receipts.
- **Blind oracle** — independent acceptance against your verbatim requirements and the running product, never against our spec.
- **Session retro** — ranks real session logs by hidden waste (`node tools/session-retro.mjs scan`).
- **JEV hints** — a tiny decision model suggests one installed skill before a turn (≥0.80 confidence, else silence). Skill recommendation cost on benchmark calibration vs classifier baseline; details in [`docs/jev.md`](docs/jev.md).

## Quality evidence & honest limits

`nullform evidence` (or `node bin/nullform.mjs evidence` in source tree) provides transparent comparative evidence:
- **Claim status**: `not-proven`. This release makes no positive causal claim that workflow skills improve software development quality.
- **Retained comparisons**: Across four constructed task pairs on one model with a single repetition, three review pairs showed equal accuracy (3/3 each) with ~2x candidate tariff spend; one workflow pair succeeded in 5 requests on baseline and halted at the 6-request cap on candidate without a final report.
- **Accounting bounds**: Costs reflect fixed SDK catalog tariffs, not independently verified provider invoices.
- **Zero additional paid A/B**: No benchmark inference runs were dispatched for this release.

## Reference

- Spec: [`core/PORTABLE.md`](core/PORTABLE.md) · Glossary: [`CONTEXT.md`](CONTEXT.md) · Roles: [`agent/agents/`](agent/agents/)
- Gates: `node tools/verify.mjs --profile verify` (or `--profile audit`) · Deterministic tests: `node --test tools/tests/*.test.mjs` (regression tests verify code stability and safety invariants, not causal AI quality improvement; see `nullform evidence`)
- Capabilities: `nullform capabilities` separates Node-native core gates and 8 host configuration adapters from OMP/Bun-specific native automated review.
- Dashboard: `node tools/dashboard.mjs --url`

## License

Project code is licensed under MIT (see [LICENSE](LICENSE)). Third-party bundled assets retain their upstream licenses: Apache 2.0 for `skills/skill-creator/`, `skills/ui-styling/`, and `skills/frontend-design-anthropic/`, SIL Open Font License 1.1 for fonts under `skills/ui-styling/canvas-fonts/`.
