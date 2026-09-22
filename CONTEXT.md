# CONTEXT.md — Domain Glossary

Terms used in this OMP workflow harness. Definitions say what a term
**means**, not how it is implemented.

## Harness topology

- **Harness** — the installed orchestration stack (agent definitions, rules,
  skills, tools) that OMP loads. Two copies exist; see *Tree*.
- **Tree** — one of the two physical copies of the harness:
  - **Live tree** — the harness root (`$HOME/omp-workflow` by default; `install.ps1 -HarnessRoot` overrides). Read by OMP at runtime.
  - **Repo tree** — the git clone you installed from. The distributable source of truth.
  - **Drift** — divergence between the two. Owned by `tools/sync.ps1`.
- **Install** — copying the repo tree onto a machine (`install.ps1`). Produces
  the live tree. Does not mutate Paseo; Paseo profile setup is an optional explicit step (`paseo/setup-paseo.ps1`).
- **Portable core** — execution-environment-agnostic specification, contracts, and interfaces (`core/PORTABLE.md`) defining the 4-wave SDD process independently of OMP or Paseo.
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
- **Double acceptance** — the Wave 4 rule when the resolved oracle model is flash-class (name matches `*flash*` or is the configured fallback): two independent oracle passes, reconciled. ACCEPT requires the two to agree; either `REJECT` forces a fix round, then a fresh pair.
- **Oracle-lite** — a single-pass Wave 4 acceptance permitted only for a small slice (≤2 files, ≤~80 diff lines), under the same evidence protocol as a full oracle pass. Anything larger goes through double acceptance.
- **Review budget** — at most one initial review plus two re-reviews per gate
  (defined by `skill://deepwork`).

## Lean engineering

- **Solution ladder** — the ordered preference for resolving implementation needs (reuse > stdlib > platform > installed dep > one-line > minimum) evaluated after understanding the task. Never applied at the expense of security, validation at boundaries, error handling with data loss risk, or accessibility.
- **Defer marker** — a single-line code comment documenting an intentional simplification ceiling: `defer: <what> | ceiling: <limit> | upgrade: <trigger>`. Recognized only when `defer:` starts the comment body immediately after the comment prefix (`//`, `#`, `--`, `;`, `/*`, `*`, `<!--`) and optional whitespace. Enables deliberate debt with an explicit boundary and upgrade trigger.
- **Debt ledger** — the registry and audit report of all active defer markers, generated and verified by `tools/debt-ledger.mjs`.

## Roles

- **Orchestrator** — the single router. Classifies, plans, schedules, reconciles,
  verifies. Does not write project code on T2+.
- **Specialist** — a delegated role with one lane of work.
- **Shipped role** — a role definition the repo distributes in `agent/agents/`. Eight
  of them: `orchestrator`, `designer`, `fixer`, `oracle`, `librarian`, `explorer`,
  `reviewer`, `sonic`.
- **Built-in role** — a role OMP itself provides: `scout`, `task`,
  `security-reviewer`. Never shipped and never forked — the harness installs and
  updates it, so taking it from the built-in set keeps it current and drift-free.
- **Forked agent** — our `agent/agents/<name>.md` that overrides a built-in role of
  the same name (`reviewer`, `sonic` today). Override is by filename, first-wins;
  OMP has no `extends`, so a fork must be re-based on the built-in body whenever the
  built-in changes. Drift is reported by the `agents-drift` check in
  `tools/doctor.mjs` (warn, never fail). Distinct from a *built-in role*, which we
  do not carry at all.
- **Writer role** — a specialist permitted to edit files (`fixer`, `designer`,
  `sonic`).
- **Read-only role** — a specialist that never edits (`explorer`, `librarian`,
  `reviewer`, `oracle`; built-in `scout`).
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
- **Benchmark task** — an isolated coding problem specification (`bench/tasks.json`) with an ID, prompt, optional setup commands, timeout, and deterministic verification checks. Never mutates the source repo directly.
- **Arm** — a named variant or configuration of an agent workflow being evaluated (e.g. `raw-model` vs `omp-workflow`), defined by a runner command template executed inside a fresh local git clone.
- **Stage B** — the simplifying second phase in the A→B→A delivery rhythm. After meeting specifications and passing tests in Stage A, the agent executes an explicit compression and deduplication pass, preserving test invariance while achieving neutral or negative net lines of code (`net: -N lines`).

## Tooling

- **Codemap** — `CODEMAP.md` per folder plus `.codemap/state.json` (hashes), built
  by `tools/codemap.mjs`. Maps **structure**; `CONTEXT.md` names **concepts**.
- **Tripwire** — `tools/prompt-lint.mjs`. Fails when a prompt surface contains a
  volatile literal or drifts from its recorded baseline.
- **Baseline** — the recorded hashes of every prompt surface (`.prompt-lint/`).
  An intentional edit requires re-running `baseline` so the change shows in review.
- **Skills-doctor** — `tools/skills-doctor.mjs`. Detects skills that the registry
  would drop silently (bad frontmatter, truncation, parity, orphans).
- **Disabled skill** — a skill named in `~/.agents/.skills-disabled.json` (an operator's stop-list). `tools/skills-doctor.mjs` reports it as `disabled by operator` and excludes it from orphan/parity problems. Distinct from a *dropped* skill, which the registry discards by accident.
- **Prune** — `tools/sync.ps1 -Prune`: lists harness files absent from the repo within manifest-covered directories (dry-run by default), deleting only with `-Confirm`; never touches `.prompt-lint`, `.workflow`, `.archmap`, `node_modules`, `worktrees`, session or config files.
- **Glossary tool** — `tools/glossary.mjs`. Drafts `CONTEXT.md` from real symbols
  and measures which public symbols are still undocumented. Never invents a
  definition; `--scope` keeps vendored tooling out of the project's glossary.
- **Replay harness** — `tools/replay.mjs`. Records a live network interaction as a
  cassette and replays it deterministically, so a runtime oracle can refute a
  network-path claim without the live service.
- **Debt ledger tool** — `tools/debt-ledger.mjs`. Scans repository code comments for `defer:` markers, checks for formatting errors or missing triggers, and generates `DEBT-LEDGER.md`.
- **Test lens** — `tools/test-lens.mjs`. Runs a test command (`run -- <cmd>`) or parses saved output (`parse <file>` / stdin) into a compact JSON summary (`total` / `passed` / `failed` / `failures`); recognizes `node --test` (spec reporter), Jest/Vitest JSON, pytest, and cargo, and otherwise falls back to a raw `fail|error|exception` filter. Exit code mirrors the command (`2` = `spawnError`, `1` = killed by signal), so a lens failure never reads as a green suite.
- **Benchmark harness** — `tools/benchmark.mjs`. Orchestrates isolated benchmark task runs across arms (`init`, `run`, `report`, `compare`), capturing objective metrics (LOC deltas, duration, check pass rates, safety pass rates across safety-tier tasks, and optional session cost).
- **Safety tier** — benchmark task tier (`tier: "safety"`) designed to test behavior preservation, boundary conditions, and invariant enforcement where lazy shortcut solutions break observable behavior.
- **Memory cadence** — `tools/memory-cadence.mjs`. Enforces a regular maintenance cadence (default 7 days) over the Hindsight long-term memory bank, tracking last review timestamps and checking configuration freshness.
- **Mutation testing** — `tools/mutation-test.mjs`. Evaluates test suite quality by injecting deliberate AST/syntax mutations (comparison flips, boolean flips, operator inversions, boundary shifts) into target source files and measuring the percentage of killed mutants.
- **Gherkin spec** — `tools/gherkin-spec.mjs`. Parses, validates, and lints executable BDD specifications (Given/When/Then scenarios) in `.feature` files and Markdown code blocks, ensuring acceptance criteria are unambiguous and verifiable.
- **Workspace script** — a service Paseo supervises (`paseo.json`), for long-lived
  processes the user must see. Distinct from **hub process**, which is an
  in-session PTY that dies with the session.
- **Hub** — in-session coordination: peer messaging, background jobs, PTY processes.
- **Paseo** — the supervising daemon: workspaces, agents, terminals, schedules.
- **Prompt budget** — sub-command (`tools/prompt-lint.mjs sizes [--check]`) and configuration (`.prompt-lint/budget.json`) enforcing size limits across agent prompt surfaces to prevent context degradation and cache thrashing.
- **Usage audit** — audit tool (`tools/usage-audit.mjs [--days 30] [--plugins]`) analyzing tool, MCP, plugin, and skill invocation frequency from local logs, surfacing unused plugins with disable recommendations.
- **Install doctor** — diagnostic harness (`tools/doctor.mjs`) validating installation prerequisites, directory structures, and environment health, acting as a hard gate during installation (`install.ps1`). Its optional `--probe` (network) checks provider reachability in `models.yml` and that each `config.yml` role points at a reachable model; unreachable = `WARN` listing the roles, never `FAIL`, and no network is touched without the flag. It also verifies the plugins named in the *plugin manifest*: a missing plugin is `WARN`, or `FAIL` under `--require-plugins`.
- **Plugin manifest** — `agent/plugins.json`. The 14 OMP plugins the repo installs (`@dietrichgebert/ponytail`, `oh-my-pi-plugin-morph`, `omp-plugin-duplicate-detector`, `omp-url-pin`, `pi-lens`, `pi-linter`, `pi-qq`, …), each a `omp plugin install <spec>` spec. Part of the install, not of the harness source: `install.ps1` applies it automatically (`-SkipPlugins` opts out) and the *install doctor* verifies presence.

## Operations

- **Rate ceiling** — gateway or provider request rate limit if present. A lane
  emits HANDOFF at ~40–45 calls before running into context limits or provider caps so the headroom survives reconciliation.
- **Session reuse** — continuing a specialist session that still holds useful
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
