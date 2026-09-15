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
- `read skill://grill-me` and follow it.
- Ask ALL forks/constraints/success criteria via ONE structured `ask` tool call (widget). NEVER as chat text.
- DO NOT scaffold OpenSpec or spawn builders until the user answers the widget.
- If the architecture is contested, spawn two `reviewer` subagents in ONE `task()` batch with competing positions, then synthesize.

## 2. Wave 1: Context & Intelligence
- `codebase_context` (semantic index) for blast-radius; fall back to `grep`/`glob` for exact ids; `codegraph_explore` only in repos with `.codegraph/`; `lsp` for symbol precision.
- Deliverable: affected files + symbols + risks, compressed, in chat.

## 3. Wave 2: OpenSpec Planning
- `openspec new change <name>`; draft `proposal.md` and `tasks.md`; `openspec validate <name>`.
- Clearly divide tasks into UI/Frontend slice vs Logic/Backend slice.
- Decide cross-slice contracts (interfaces, schemas, file ownership) UP FRONT in the batch `context`.

## 4. Wave 3: Subagent Spawning — native `task()` ONLY
- ONE `task()` batch with all independent slices. Never serialize concurrent slices.
- UI/Design slice → `agent: "designer"` (isolated: true). Executes its 8-phase pipeline (refero-design → design-taste-frontend → … → BEFORE/AFTER screenshots).
- Logic/Backend slice → `agent: "fixer"` (isolated: true). TDD: failing test first, then fix.
- Writers isolated, one owner per file; read-only roles (`scout`, `reviewer`, `oracle`) never edit.
- Every spawn: bounded scope + acceptance criteria + typed yield `{status, files_modified, tests_passed, summary}`.
- NEVER use slash-commands like `/paseo-handoff` — they are skills, not commands. Delegation = native `task()` tool.

## 5. Wave 4: Oracle Verification Gate
- Spawn `agent: "oracle"` for independent blind acceptance — against the **manifest** (verbatim user quotes) and the running product, NEVER against `proposal.md` or `specs/`: judging our build by our own paraphrase confirms the plan, not the product.
- Subagent `status: success` is a CLAIM until spot-checked.
- Verify diff test coverage of changed behavior; run deterministic checks (diagnostics/build/tests) before LLM judgment. For any network-path change, require a replay cassette (`node tools/replay.mjs verify --cassette <file>`) — a mock written by the same process as the code is not evidence.
- On approval: synthesize → report → `openspec archive <name> --yes`.
