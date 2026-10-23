---
name: nullform
description: "Universal autonomous engineering workflow: interactive Briefing, test-driven Build waves, and evidence-verified Review."
disable-model-invocation: true
argument-hint: "[tier] [task]"
version: 1.3.0
metadata:
  version: "1.3.0"
---

# Universal Nullform Workflow

Autonomous software delivery process: interactive Briefing, test-driven Build waves, and evidence-verified Review.

## 1. Quick Installation

Install this skill into your agent harness with a single command via `npx skills add`:

```bash
npx skills add wdnameless/nullform-workflow --skill nullform
```

For direct repository URL usage:
```bash
npx skills add https://github.com/wdnameless/nullform-workflow --skill nullform
```

Once installed, verify the registry health with our diagnostic tool:
```bash
node tools/skills-doctor.mjs
```

---

## 2. Version Check & Updates

Nullform evolves with regular protocol and tooling updates. Compare your locally installed skill version against the upstream canonical repository (`VERSION` in `wdnameless/nullform-workflow`):

1. **Check local version**:
   Declared in this skill's frontmatter and in the root `VERSION` file (currently `1.3.0`).
2. **Check remote version**:
   Inspect the canonical upstream `VERSION` or release tag:
   ```bash
   curl -s https://raw.githubusercontent.com/wdnameless/nullform-workflow/main/VERSION
   ```
3. **Update when stale**:
   When your installed version is behind the repository `VERSION`, update the skill directly:
   ```bash
   npx skills update nullform
   ```
   Or reinstall the skill from the canonical repository:
   ```bash
   npx skills add wdnameless/nullform-workflow --skill nullform
   ```
   For full workflow installations (CLI, tools, and harness adapters):
   ```bash
   node bin/nullform.mjs update --dry-run
   node bin/nullform.mjs update --yes
   ```

---

## 3. Process Lifecycle: Briefing → Build → Review

The workflow coordinates human-agent and multi-agent engineering across three structured phases:

```
[Briefing] ──▶ [Build] ──▶ [Review]
     │             │            │
     ▼             ▼            ▼
Manifest (R##)  Wave Slices   Quality Gates &
Doctor Preflight TDD & Dash    Blind Acceptance
```

Detailed phase guides are available in the dedicated references:
- **Phase 1: Briefing** (`phases/briefing.md`) — Context, operator interviews, pre-flight diagnostics, and requirement atomization.
- **Phase 2: Build** (`phases/build.md`) — Lane initialization, wave execution, TDD loop, size calibration, and dashboard.
- **Phase 3: Review** (`phases/review.md`) — Stage-B simplification, automated quality gates, blind oracle acceptance, and task closure.

---

### Phase 1: Briefing (Контекст, ограничения и манифест)

See `phases/briefing.md` for the complete guide.

1. **Pre-flight Health Diagnostics**:
   ```bash
   node tools/doctor-lite.mjs
   ```
   Verifies environment prerequisites, tool syntax, harness assets, and skills-lock integrity in under 2 seconds.

2. **Interactive Briefing Rounds**:
   ```bash
   node tools/workflow.mjs brief --rounds 3
   ```
   Elicits constraints, architecture seams, and test commands from the operator. Records answers into `openspec/changes/<change>/manifest.md`.

3. **Requirements Atomization**:
   Assign stable identifiers (`R01`, `R02`, etc.) with verbatim user quotes and observable acceptance criteria.

4. **Tier Classification**:
   - `T0`: Trivial fix (1–2 known files).
   - `T1`: Lean change with reconnaissance note (`recon.md`).
   - `T2`: Full OpenSpec change (`manifest.md`, `proposal.md`, `tasks.md`, `specs/`, `interfaces.md`, `oracle.md`).
   - `T3`: Multi-slice program with isolated git worktrees (`worktrees.md`).

---

### Phase 2: Build (Волновая разработка, TDD и калибровка)

See `phases/build.md` for the complete guide.

1. **Task Initialization**:
   ```bash
   node tools/workflow.mjs start --tier T2 --task "Task description"
   ```

2. **Wave Decomposition & Size Calibration**:
   - Slices target a calibrated budget of ~3,000 lines per ticket.
   - Independent slices run in parallel; T3 uses isolated worktrees.

3. **Live Orchestration Dashboard**:
   ```bash
   node tools/dashboard.mjs
   ```
   Tracks run progress, wave completion, time active/wait, and token budgets.

4. **Test-Driven Feedback Loop (TDD)**:
   - Noise-reduction lens keeps test cycles fast:
     ```bash
     node tools/test-lens.mjs run -- node --test <test-file>
     ```
   - Follow the Ponytail ladder: reuse existing utilities, stdlib first, zero unrequested dependencies.

5. **Protocol Conformance Check**:
   ```bash
   node tools/workflow.mjs check
   ```

---

### Phase 3: Review & Acceptance (Качество, гейты и приёмка)

See `phases/review.md` for the complete guide.

1. **Stage-B Simplification (Frozen Tests)**:
   - Freeze Stage-A test assertions:
     ```bash
     node tools/workflow.mjs stage-b --phase before --test-cmd "<test-command>"
     ```
   - Strip redundant abstractions, flatten nesting, remove single-implementation wrappers.
   - Re-verify frozen suite:
     ```bash
     node tools/workflow.mjs stage-b --phase after --disposition simplified
     ```

2. **Automated Quality Gates (`check-ci`)**:
   ```bash
   node tools/workflow.mjs check-ci --quality
   ```
   Enforces four checks: `code-size`, `debt-ledger`, `logs-hygiene`, and `orphan-files`.

3. **Blind Oracle Acceptance**:
   ```bash
   node tools/workflow.mjs artifact --kind oracle --detail "ACCEPT: all R## criteria verified against live runtime"
   ```
   Independent verification strictly against `manifest.md` requirements and runtime evidence.

4. **Task Finalization**:
   ```bash
   node tools/workflow.mjs close
   ```

---

## 4. Essential Command Summary

| Command | Purpose |
|---|---|
| `node tools/doctor-lite.mjs` | Fast (<2s) environment and harness diagnostic pre-flight |
| `node tools/workflow.mjs brief --rounds 3` | Interactive CLI briefing to generate requirements manifest |
| `node tools/workflow.mjs start --tier T2 --task "..."` | Initialize workflow task with governance tier |
| `node tools/dashboard.mjs` | Launch local live dashboard (waves, status, metrics) |
| `node tools/workflow.mjs check` | Verify task artifacts conformance |
| `node tools/workflow.mjs check-ci --quality` | Run code-size, debt-ledger, logs-hygiene, and orphan gates |
| `node tools/workflow.mjs close` | Seal task artifacts, record metrics, and clean state |
