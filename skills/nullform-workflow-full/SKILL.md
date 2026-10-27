---
name: nullform-workflow-full
description: "Enterprise 4-Wave SDD Multi-Agent Workflow: Wave 0 Grilling (ask widget), Wave 1 Context, Wave 2 OpenSpec, Wave 3 parallel subagents via native task() (@designer UI, @fixer TDD), Wave 4 Oracle blind acceptance."
user-invocable: true
---

# Enterprise 4-Wave SDD Orchestration Workflow

Activated explicitly by the user or project for complex architecture and multi-agent development.
Canonical specification: read `<HARNESS>/core/PORTABLE.md` (or harness install root) for full wave definitions, interface rules, fleet execution, and evidence gates.
Quality contract: read `<HARNESS>/core/PORTABLE.md` §10 for the canonical product quality contract (applicable outcomes, workload/environment/limits, command/evidence, architecture boundaries, role non-duplication). Roles reference this section; no duplicated checklists.

## 0. MANDATORY STATUS HEADER
When active, lead with the lane verdict as the first line of responses:
> **NULLFORM** ● FULL WORKFLOW — Enterprise SDD & Subagents Active

## 1. 4-WAVE SDD LIFECYCLE SUMMARY
- **Wave 0 (Clarification / Grilling)**:
  - Interview ONLY for unresolved decisions, forks, and constraints NOT settled by sources (`skill://grill-me` when supported, otherwise `<HARNESS>/skills/grill-me/SKILL.md`). If settled, skip.
  - Ask all questions via ONE structured `ask` widget call (never plain chat text). Do not write code or scaffold OpenSpec until answered.
- **Wave 1 (Context & Manifest)**:
  - Map blast-radius with native tools (`codebase_context`, `lsp`, `grep`, `glob`).
  - Create requirements manifest (`openspec/changes/<name>/manifest.md`) atomizing user words into `R01`..`Rnn` with verbatim quotes and observable acceptance.
- **Wave 2 (OpenSpec Planning)**:
  - Run `openspec new change <name>`.
  - Author human-readable `proposal.md`, dependency graph `tasks.md` with blocking edges, and deep modules in `interfaces.md` (seams on consumer side; Ousterhout's rule). Derive the module list from the functions first, never from a target count; a `shared`/`helpers` zone is a finding. Expand-Contract for wide refactors (>3 files).
- **Wave 3 (Subagent Spawning)**:
  - Native `task()` batches along ready frontiers.
  - `@designer` for UI/design pipeline; `@fixer` for logic/TDD (failing test first).
  - Writers isolated (`isolated: true` in git repos), one owner per file, disjoint zones.
  - Enforce worker return contract (STATUS, FILES, TESTS `было→стало`, INTERFACES, REQUIREMENTS, CONCERNS/BLOCKERS; ≤25 lines).
- **Wave 3.5 (Implementation Review & Stage B)**:
  - `@reviewer` inspects patch and dispatch points, producing tagged delete-list.
  - Capture Stage-A green tests (`node tools/workflow.mjs stage-b --phase before --test-cmd "<cmd>"`), apply simplification with frozen tests, record Stage B after state (`stage-b --phase after --disposition <simplified|lean-already>`).
- **Wave 4 (Oracle Blind Acceptance)**:
  - `@oracle` performs independent blind acceptance strictly against `manifest.md` (verbatim `R##` quotes) and running runtime (`product-command`), NEVER against `proposal.md` or specs.
  - Flash-class models require Double Acceptance (two independent passes).

## 2. STABLE CLI COMMANDS
```bash
nullform workflow start --tier T2 --task "<task description>" [--no-dashboard]
nullform workflow artifact --kind manifest --path openspec/changes/<name>/manifest.md
nullform workflow artifact --kind openspec --path openspec/changes/<name>
nullform workflow artifact --kind interfaces --path openspec/changes/<name>/interfaces.md
nullform workflow artifact --kind oracle --detail "ACCEPT: <evidence>"
nullform workflow check
nullform workflow close
```
*(Also callable as `node '<HARNESS>/tools/workflow.mjs' ...`)*

## 3. REVIEW EVIDENCE & SAFETY BOUNDARIES
- Strict gates (`workflow.mjs check-ci`) validate `review-evidence.json` with actual execution receipts.
- New automated review runs require controlled Node transport `nullform-http-v1` with `--admission-policy <path>` (provider/model/endpoint/tariffs/credential-env from user config) and authorized funding:
  ```bash
  node tools/workflow.mjs review-run --role reviewer --change <name> --model <provider>/<model> --base-ref <base> --admission-policy <policy-path>
  node tools/workflow.mjs review-run --role oracle --change <name> --model <provider>/<model> --base-ref <base> --admission-policy <policy-path> --product-command '["node","product-entry.mjs"]'
  ```
- Historical native OMP evidence remains distinguishable and verified from session events, but no monetarily-enforced native SDK dispatch is enabled in CLI.
- No source-hash exemptions, no fixture-as-release, no static-ACCEPT markdown bypass.
- Receipts establish auditable native execution provenance, not cryptographic attestation or sandbox isolation.
