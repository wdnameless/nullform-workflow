# Harness simplification

## Why

The user asked for an audit of this harness and for a plan to make it maintainable, minimal,
clean, and understandable by both a human and an AI agent. Four independent read-only scouts
audited core tools, prompt surfaces, install/sync, duplication, and docs-claims; every
high-severity claim was then re-verified by a command in the auditing session, and one claim
was refuted.

Measured state of the tree:

- **Infrastructure re-implemented in every tool** — argv handling in 25 files, `readdirSync`
  walks in 17, JSON-state writers 7, git invocation in 15 call sites across 4 tools. Measured
  by blind acceptance: every one of these is cheaper to *delete against the standard library*
  than to abstract — the `node_modules` crawl the walkers avoid costs 7–13 ms, and only 3 test
  files depend on the custom error-collection behaviour.
- **Five modules carry more than one reason to change** — `dashboard.mjs` 2 942 LOC,
  `benchmark.mjs` 1 614, `workflow.mjs` 1 579, `doctor.mjs` 1 460 (one 920-line function),
  `verify.mjs` 1 242.
- **~1 100 LOC of dead code** — `install-harness.mjs` exports 10 functions imported by
  nothing; `verify.mjs` exports 14 of which one is used; `workflow.mjs` exports 6 unused.
- **Two installers and two sync scripts implement one behaviour twice** — the 55-entry sync
  manifest is hardcoded in both `sync.ps1` and `sync.sh`, which is why
  `tools/install-harness.mjs` exists in the repo and not in the live harness.
- **The gate is optional by lane** — a T1 PR changing 54 files passes CI (exit 0).
- **Nine unmerged branches**, four conflicting pairs, `master` 52 commits behind.

And eight confirmed defects, including a repo-contaminating `sync -Promote`, an OMP prompt
file that has been stale for days, a role prompt that mandates a tool it does not have, and
verification checks that pass when their subject is missing.

## What changes

Nothing in this change: this is the audit and the plan. The defects are recorded with
reproductions, and the remediation steps are sequenced with the invariant that `29/29`
install checks, `14/14` audit checks and 366 tests stay green at every step.

The plan was revised three times, each after a blind-acceptance rejection — all three on the
same axis, the user's own minimalism criterion. Draft 1 proposed **seven** new modules; draft 2
replaced them with bare stdlib calls that provably break existing contracts; draft 3 proposed
**three** justified modules, and acceptance measured each "gap" as milliseconds or a single
type conversion. The current plan creates **no shared modules**: duplication is deleted against
the standard library and the one genuinely unsafe writer is fixed inline. See `oracle.md` for
the full evidence of each round.

## Out of scope

- Deleting skills, providers, or the vendored `typescript` — reported, but a user decision.
- Any rewrite of working code before the user picks a step: LAW 2 requires explicit approval
  to replace what already works.
- Product features. This change touches only the harness's own correctness and structure.

## Decisions the user must make

1. Which remediation steps to execute, and in what order (R09–R15 are independent enough to
   be taken one at a time).
2. Whether the two-tree model (`repo` ↔ live harness) is kept at all. It costs two sync
   scripts, two installers, a 55-entry hand-maintained manifest and an entire class of drift
   bugs. Making `~/.omp/agent/agents` a link into the repo — which `install.ps1:349` already
   does for the role roster — would delete most of this surface.
3. Whether the 69-skill payload (18 unreferenced, 12 MB) is a feature or accumulated weight.
