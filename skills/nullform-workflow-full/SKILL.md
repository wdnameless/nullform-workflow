---
name: nullform-workflow-full
description: "Enterprise 4-Wave SDD Multi-Agent Workflow: Wave 0 Grilling (ask widget), Wave 1 Context, Wave 2 OpenSpec, Wave 3 parallel subagents via native task() (@designer UI, @fixer TDD), Wave 4 Oracle blind acceptance."
user-invocable: true
---

# NULLFORM Enterprise 4-Wave SDD Orchestration Workflow

When active or triggered, the lead agent acts STRICTLY as an Orchestrator.

## 0. Mandatory First Line:
> **NULLFORM** ● FULL WORKFLOW — Enterprise SDD & Subagents Active

## 1. Wave 0: Scope & Grilling Protocol
- NEVER write implementation code directly.
- T1 NEVER mandates a Wave 0 interview.
- For T2/T3: interview ONLY for unresolved user decisions, forks, and constraints NOT settled by sources (`read skill://grill-me`). If all decisions are settled by sources, skip the interview.
- When unresolved decisions remain: ask ALL forks/constraints/success criteria via ONE structured `ask` tool call (widget). NEVER as chat text.
- DO NOT scaffold OpenSpec or spawn builders until the user answers the widget.
- If the architecture is contested, spawn two `reviewer` subagents in ONE `task()` batch with competing positions, then synthesize.
## 2. Wave 1: Context & Intelligence
- `codebase_context` (semantic index) for blast-radius; fall back to `grep`/`glob` for exact ids; `codegraph_explore` only in repos with `.codegraph/`; `lsp` for symbol precision.
- Deliverable: affected files + symbols + risks, compressed, in chat.

## 3. Wave 2: OpenSpec Planning
- `openspec new change <name>`; draft `proposal.md` and `tasks.md`; `openspec validate <name>`.
- Clearly divide tasks into UI/Frontend slice vs Logic/Backend slice.
- Decide cross-slice contracts (interfaces, schemas, file ownership) UP FRONT in the batch `context`.

- Tasks are a graph, not a list: record blocking edges (`blocked-by: <task-id>`)
  in `tasks.md`. Every wave launches the ready FRONTIER (all unblocked,
  disjoint tasks) — never the whole list at once.
- Open an integration branch for the change (`feat/<name>-integration`);
  per-ticket work lands there via merge, never straight to `main`.
## 4. Wave 3: Subagent Spawning — native `task()` ONLY
- ONE `task()` batch per FRONTIER (all currently unblocked, disjoint tickets).
  Never serialize frontier-mates; when one returns, launch the next unblocked
  ticket, then reconcile. A wave is not a barrier.
- UI/Design slice → `agent: "designer"` (`isolated: true` ONLY if cwd is git repository). Executes its 8-phase pipeline (refero-design → design-taste-frontend → … → BEFORE/AFTER screenshots).
- Logic/Backend slice → `agent: "fixer"` (`isolated: true` ONLY if cwd is git repository). TDD: failing test first, then fix.
- Writers isolated (when in git repo), one owner per file; read-only roles (`scout`, `reviewer`, `oracle`) never edit.
- Every spawn: bounded scope + acceptance criteria + return contract (STATUS | FILES paths-only | TESTS `было→стало` counts | INTERFACES public signatures | REQUIREMENTS R## mapping | CONCERNS/BLOCKERS; ≤25 lines). `tests_passed: true` without executed command/counts is not evidence and must be rejected at parent reconciliation.
- Implement-subagents merge to the integration branch when their ticket is green
  (reviewed diff + full suite counts read by the parent); the reviewer then
  reads the integration branch as a whole before Wave 4.
- Deterministic loop beats agent loop: when tickets are uniform (same shape,
  same tests), prefer a script that feeds tickets one by one over an agent
  babysitting subagents — same result every run, no babysitter tokens.
- NEVER use slash-commands like `/paseo-handoff` — they are skills, not commands. Delegation = native `task()` tool.

## 4.5. Wave 3.5: Implementation Code Review & Stage B Simplification
- Spawn `agent: "reviewer"` for implementation review: inspects diff/patch, changed files, and consuming-side dispatch points (switches, routers, handlers receiving new types/variants). Reviewer produces a tagged delete-list (`delete:`, `stdlib:`, `native:`, `yagni:`, `shrink:`).
- Heavy/program changes require recorded native reviewer execution evidence:
  ```bash
  node tools/workflow.mjs review-run --role reviewer --change <name> --model <provider/model> --base-ref <review-base>
  ```
- Recorded reviewer mode uses `inspect_product`/`exercise_product` and one terminal assistant JSON object: `findings`, `overall_correctness` (`correct` or `incorrect`), `overall_explanation`, `overall_confidence_score` (0–1). Do not send unavailable incremental yield calls.
- Before applying the reviewer delete-list, capture the reviewer-A green Stage-A tests. Then simplify with those tests FROZEN and record the actual after-state (including legitimate Lean-already):
  ```bash
  node tools/workflow.mjs stage-b --change <name> --phase before --test-cmd "<cmd>"
  # Apply simplification without editing the Stage-A test set.
  node tools/workflow.mjs stage-b --change <name> --phase after --test-cmd "<same-cmd>" --disposition <lean-already|simplified>
  ```

## 5. Wave 4: Oracle Verification Gate (Blind Acceptance)
- Spawn `agent: "oracle"` for independent blind acceptance — strictly against the **manifest** (`manifest.md`, verbatim user quotes R##) and the running product/runtime, NEVER against `proposal.md`, `specs/`, or tickets: judging our build by our own paraphrase confirms the plan, not the product.
- Record native oracle execution evidence:
  ```bash
  node tools/workflow.mjs review-run --role oracle --change <name> --model <provider/model> --base-ref <review-base> --product-command '["node","product-entry.mjs"]'
  ```
- The oracle exercises the fixed operator-supplied JSON argv through `exercise_product`; its terminal assistant report is text with each R## result and raw runtime evidence, ending `Verdict: ACCEPT` or `Verdict: REJECT`. Native JSON event transport does not change that report into reviewer JSON.
- **Flash-class → Double Acceptance**: if resolved oracle model matches `*flash*` or is the configured fallback entry, two distinct successful native oracle sessions on identical current source and manifest are mandatory. Single pass allowed ONLY for proven Oracle-lite (≤2 files, ≤~80 lines changed).
- Gates (`workflow.mjs check`, `close`, `check-ci`) validate `review-evidence.json`: requires reviewer evidence, Stage-B disposition with frozen test verification, and sufficient oracle passes with nonzero token usage, valid exit status, matching manifest/source hashes. Static ACCEPT markdown alone is rejected.
- Operational boundaries: execution receipts establish auditable native-execution provenance, not cryptographic attestation or sandbox isolation.
- On approval: synthesize → report → `openspec archive <name> --yes`.
