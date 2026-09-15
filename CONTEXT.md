# CONTEXT.md — Domain Glossary

Terms used in the Nullform OMP + Paseo harness. Definitions say what a term
**means**, not how it is implemented.

## Harness topology

- **Harness** — the installed orchestration stack (agent definitions, rules,
  skills, tools) that OMP loads. Two copies exist; see *Tree*.
- **Tree** — one of the two physical copies of the harness:
  - **Live tree** — `D:\ohmypi`. Read by OMP at runtime. Edited during work.
  - **Repo tree** — `D:\ohmypi\workflow-repo`. The git-tracked distributable.
  - **Drift** — divergence between the two. Owned by `tools/sync.ps1`.
- **Install** — copying the repo tree onto a machine (`install.ps1`). Produces
  the live tree and registers the Paseo profile.
- **Prompt surface** — any file whose text reaches a model's context:
  `agent/AGENTS.md`, `agent/agents/*.md`, `~/.agents/rules/*.md`,
  `~/.agents/skills/*/SKILL.md`. Not a synonym for *rule* or *skill*: those are
  two of the four surface kinds.

## Work lanes

- **Lane** — the classification of a task that selects its protocol. Four lanes:
  - **T0 (Fast)** — 1–2 known files, localized. Direct edit or one specialist.
  - **T1 (Standard)** — 3+ files or unfamiliar area. Recon, micro-plan, 1–2 specialists.
  - **T2 (Heavy)** — architecture, new module, multi-system. Full 4-Wave SDD.
  - **T3 (Program)** — multi-feature program. T2 per slice, isolated worktrees.
- **Down-classify** — assigning a lower lane than the work warrants to save time.
  Prohibited; T0 is only for genuinely trivial edits.
- **Escalate** — re-classifying upward when a lane stalls.

## 4-Wave SDD

- **Wave** — one phase of the T2 protocol. Waves are numbered, not a *barrier*.
- **Grilling** — the structured interview (Wave 0) that resolves forks,
  constraints, and success criteria before any artifact is created.
- **Manifest** — `manifest.md`. The atomised requirements list, one row per
  requirement (`R01…Rnn`), each carrying the **verbatim** user quote it came
  from plus a status.
- **Requirement status** — `open | in-spec | in-ticket | done | placeholder |
  deferred | dropped`. `dropped` requires the user's own words; silence never
  cancels a requirement.
- **Interfaces contract** — `interfaces.md`. Module boundaries, public
  signatures, and ownership zones, seeded before any build spawn.
- **Gate** — a mandatory checkpoint (G1–G4). A failed gate sends the phase back.
- **Blind acceptance** — Wave 4. The oracle judges the product against the
  manifest and the running artifact, never against our own spec.
- **Oracle** — the read-only acceptance role. See *Roles*.
- **Review budget** — at most one initial review plus two re-reviews per gate
  (defined by `skill://deepwork`).

## Roles

- **Orchestrator** — the single router. Classifies, plans, schedules, reconciles,
  verifies. Does not write project code on T2+.
- **Specialist** — a delegated role with one lane of work.
- **Writer role** — a specialist permitted to edit files (`fixer`, `designer`).
- **Read-only role** — a specialist that never edits (`scout`, `explorer`,
  `reviewer`, `oracle`).
- **Fleet** — the set of specialists dispatched for a task.
- **Spawn** — creating a specialist run (`task()`). Distinct from **reuse**, which
  continues an existing specialist session that already holds relevant context.
- **Reconcile** — reading a terminal specialist result and folding it into the
  orchestrator's outcome. A result is not consumed until reconciled.
- **Return contract** — the fixed ≤25-line yield shape:
  STATUS / FILES / TESTS / INTERFACES / REQUIREMENTS / CONCERNS.
- **HANDOFF** — the yield that ends a lane early when it outgrows its tool-call
  ceiling, carrying `РЕШЕНИЯ / ТУПИКИ / ДАЛЬШЕ` for a successor.

## Engineering disciplines

- **CONTEXT.md** — this file. The glossary. Domain terms only; never a spec, a
  scratch pad, or a home for implementation decisions.
- **ADR** — Architectural Decision Record. Written only when a decision is hard
  to reverse, surprising without context, and the result of a real trade-off.
- **Deep module** — a lot of behaviour behind a small interface.
- **Shallow module** — an interface nearly as complex as its implementation, or a
  1:1 pass-through wrapper. Rejected by the oracle.
- **Deletion test** — if deleting a module lets its complexity vanish without
  spreading across callers, it was a shallow wrapper.
- **Seam** — a place where behaviour can be altered without editing the consuming
  source. Interfaces belong to the consumer, not the provider.
- **Expand–Contract** — the protocol for a wide refactor (>3 files or a shared
  contract): expand the new form beside the old, migrate callers in batches,
  contract the old form only when nothing references it.
- **Evidence path** — the project-specific route from a claim to evidence that
  can establish, limit, or refute it. Built before non-trivial work.
- **Verification affordance** — a capability added so a claim can be observed
  directly rather than inferred. May be temporary or durable; decide which.
- **Red-capable loop** — a reproduction that genuinely fails on the reported bug.
  Required before implementation code is read or touched.

## Tooling

- **Codemap** — `CODEMAP.md` per folder plus `.codemap/state.json` (hashes), built
  by `tools/codemap.mjs`. Maps **structure**; `CONTEXT.md` names **concepts**.
- **Tripwire** — `tools/prompt-lint.mjs`. Fails when a prompt surface contains a
  volatile literal or drifts from its recorded baseline.
- **Baseline** — the recorded hashes of every prompt surface (`.prompt-lint/`).
  An intentional edit requires re-running `baseline` so the change shows in review.
- **Skills-doctor** — `tools/skills-doctor.mjs`. Detects skills that the registry
  would drop silently (bad frontmatter, truncation, parity, orphans).
- **Glossary tool** — `tools/glossary.mjs`. Drafts `CONTEXT.md` from real symbols
  and measures which public symbols are still undocumented. Never invents a
  definition; `--scope` keeps vendored tooling out of the project's glossary.
- **Replay harness** — `tools/replay.mjs`. Records a live network interaction as a
  cassette and replays it deterministically, so a runtime oracle can refute a
  network-path claim without the live service.
- **Workspace script** — a service Paseo supervises (`paseo.json`), for long-lived
  processes the user must see. Distinct from **hub process**, which is an
  in-session PTY that dies with the session.
- **Hub** — in-session coordination: peer messaging, background jobs, PTY processes.
- **Paseo** — the supervising daemon: workspaces, agents, terminals, schedules.

## Operations

- **Soft request budget** — the internal per-run tool-call ceiling
  (`softRequestBudget`). Not the real limit; see *Rate ceiling*.
- **Rate ceiling** — the gateway's hard limit (60 requests / 30 min). A lane
  emits HANDOFF at 40–45 calls so the headroom survives reconciliation.
- **Session reuse** — continuing a specialist session that still holds useful
  context, instead of spawning a cold one. Saves tokens and quota.
- **Session snapshot** — the skill registry is read once at session start. A skill
  installed mid-session does not resolve as `skill://<name>` until restart, even
  though its rules may already be embedded in agent files.
- **Codemap state** — `.codemap/state.json`. Gitignored; scan config persists
  inside it so `changes`/`update` need no repeated flags.

## Flagged

Terms with real but non-blocking ambiguity, recorded so they are not re-derived:

- **"Wave"** — a fixed phase number in the T2 protocol, but `skill://deepwork`
  also speaks of free-form "phases". Waves are protocol-defined; phases are
  plan-defined. Both are used deliberately.
- **"Budget"** — refers to either the internal `softRequestBudget` or the gateway
  rate ceiling. Always say **soft budget** or **rate ceiling**; never bare "budget".
- **"Agent"** — can mean an OMP role definition (`agent/agents/*.md`) or a Paseo
  agent session. Say **role** or **Paseo agent** when the distinction matters.
