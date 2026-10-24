# Tasks — stack-aware quality gate

Every item below was executed in this change; none is planned-but-unbuilt.

## 1. Reconnaissance (measure before designing)

- [x] 1.1 Probe every analyzer the lecture names, on this host: sonarjs 4.2.2 (687 fns, median 8, 186 above 15, max 315); pylint-cognitive-complexity 0.1.1 (`(15/4)`); clippy 1.98 (`(6/5)` via `CLIPPY_CONF_DIR`); SonarAnalyzer.CSharp 10.35 S3776 (`21/15`, needs `.editorconfig` because the rule is off by default)
- [x] 1.2 Verify `eslint --suppress-all` is not a ratchet: it writes `{file: {rule: {count}}}` and 4→5 nested `if` still exits 0
- [x] 1.3 Prove a sidecar compose-works with a project flat config (`import base from "./eslint.config.mjs"`, exit 0)
- [x] 1.4 Confirm which toolchains exist here: node, python, cargo, dotnet — and which do not: go, ruby, php, pmd, detekt, swiftlint

## 2. Implementation

- [x] 2.1 `tools/quality/parsers.mjs` — nine analyzer dialects → one `Row` shape
- [x] 2.2 `tools/quality/stacks.json` — ten stacks as data (`markers`, `coco`, `metric`, `threshold`, `run`, `install`, `configs`, `verifiedOn`)
- [x] 2.3 `tools/quality.mjs` — `detect`, `plan`, `install`, `check`, `baseline`; stdlib plus two existing local modules
- [x] 2.4 Ratchet: `new` above threshold, `growth` past a recorded value, `baseline` re-seeds with `min(recorded, measured)`
- [x] 2.5 Honest degradation: empty stdout → `tool-error`; unreadable payload → `unparsable`; no tool → `missing-tool`; unseeded → `unseeded`; all exit 1
- [x] 2.6 Seed this repo's baseline (242 node + 45 python entries) so `check` is green on day one
- [x] 2.7 Real analyzer installation: pinned versions, `whenPresent` variant so an existing eslint major is not replaced
- [x] 2.8 Windows package-manager shims launched without a shell (`npm-cli.js` resolution already in this repo)

## 3. Wiring

- [x] 3.1 `nullform quality …` passthrough + `COMMANDS` table in `bin/nullform.mjs` (the if-chain became a table; `doctor`/`--help` re-verified)
- [x] 3.2 `package.json`: `eslint-plugin-sonarjs@4.2.2`, `quality` / `quality:baseline` scripts, `tools/quality/**` in `files`
- [x] 3.3 `tools/sync-manifest.json`: three entries for installed-harness parity
- [x] 3.4 `.github/workflows/repo-gate.yml` and `templates/ci/workflow-gate.yml`: one step each, gated on `.quality-baseline.json`; YAML parsed
- [x] 3.5 `.gitignore`: `.quality/` ignored, `.quality-baseline.json` committed

## 4. Verification

- [x] 4.1 `node --test tools/tests/quality.test.mjs` → 16/16
- [x] 4.2 Negative proof: three nested `if` in `tools/plan-check.mjs` turned exit 0 into exit 1 (`117 > baseline 106`)
- [x] 4.3 Baseline-floor proof: a baseline raised to 200 re-seeded to the measured 106 and reported `1 lowered`
- [x] 4.4 Fresh-project proof: bare `package.json` project received real devDeps, then `check` caught a new offender (exit 1)
- [x] 4.5 Mutation proof for the empty-report guard: deleting the branch fails the new test (15/16), restoring passes (16/16)
- [x] 4.6 Refactored instead of re-seeding whenever the gate fired on this change (`runQualityCli`, `parseCliArgs`, `main`)
- [x] 4.7 `npm run lint` exit 0; `node tools/code-size.mjs check` PASS
- [x] 4.8 Blind oracle audit → ACCEPT; its one substantiated gap fixed in a follow-up commit
- [x] 4.9 Pre-existing failures distinguished from mine: `workflow-suggest` "close verifies diff lines cap" fails identically at base `ac107dc` (pristine worktree, 9/10); `prompt-lint scan` likewise fails at base (user-home skills)

## 5. Documentation

- [x] 5.1 `docs/quality-gate.md` — commands, exit codes, ratchet contract, escape hatch, matrix, proxy discipline, boundaries
- [x] 5.2 `docs/dependency-policy.md` — pin count 6 → 7
- [x] 5.3 `CONTEXT.md` — `Quality gate` and `Proxy metric` terms
- [x] 5.4 `openspec/changes/stack-aware-quality-gate/{proposal,manifest,interfaces,spec}.md` validated with `openspec validate --strict`

## Not done, deliberately

- Go/Java/Kotlin/PHP adapters are unproven here: no toolchain on this host. `verifiedOn: null`, and `detect` prints `UNPROVEN on this host`. No correctness claim is made for them.
- No native `review-evidence.json`: the audit was a read-only oracle subagent, not the paid HTTP review transport. Recorded in `legacy-acceptance.md` with its reason.
