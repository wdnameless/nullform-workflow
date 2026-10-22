---
name: nullform
description: "Universal autonomous engineering workflow: interactive Briefing, test-driven Build waves, and evidence-verified Review."
version: 1.0.0
---

# Universal Nullform Workflow

Autonomous software delivery process: interactive Briefing, test-driven Build waves, and evidence-verified Review.

## 1. Quick Installation

Install this skill into your agent harness with a single command via `npx skills add`:

```bash
npx skills add nullform/workflow-repo --skill skills/nullform
```

For local or direct repository usage:
```bash
npx skills add https://github.com/nullform/workflow-repo --skill skills/nullform
```

Once installed, verify the registry health with our diagnostic tool:
```bash
node tools/skills-doctor.mjs
```

---

## 2. Process Lifecycle: Briefing → Build → Review

The workflow coordinates human-agent and multi-agent engineering across three structured phases:

```
[Briefing] ──▶ [Build] ──▶ [Review]
     │             │            │
     ▼             ▼            ▼
Manifest (R##)  Wave Slices   Quality Gates &
Doctor Preflight TDD & Dash    Blind Acceptance
```

---

### Phase 1: Briefing (Контекст, ограничения и манифест)

The goal of Briefing is to eliminate ambiguity before writing implementation code. All requirements are atomized and agreed upon upfront.

1. **Interactive Briefing Rounds**:
   Interview the operator for unresolved decisions, technical constraints, and priorities:
   ```bash
   node tools/workflow.mjs brief --rounds 3
   ```
   Answers are recorded as addenda in `openspec/changes/<change>/manifest.md`.

2. **Requirements Atomization**:
   Every requirement is assigned a stable identifier (`R01`, `R02`, etc.) with verbatim user quotes and concrete, observable acceptance criteria.

3. **Pre-flight Health Diagnostics**:
   Verify the local environment, runtime binaries, dependencies, and configuration health before opening work:
   ```bash
   node tools/doctor-lite.mjs
   # or full diagnostics:
   node tools/doctor.mjs
   ```

4. **Tier Classification**:
   Determine task governance tier:
   - `T0`: Trivial fix (1–2 known files).
   - `T1`: Lean change with reconnaissance note (`recon.md`).
   - `T2`: Full OpenSpec change (`manifest.md`, `proposal.md`, `tasks.md`, `specs/`, `interfaces.md`, `oracle.md`).
   - `T3`: Multi-slice program with isolated git worktrees (`worktrees.md`).

---

### Phase 2: Build (Волновая разработка, TDD и калибровка)

The goal of Build is disciplined, test-driven implementation without speculative abstractions.

1. **Task Initialization**:
   Declare the active task lane in workflow state:
   ```bash
   node tools/workflow.mjs start --tier T2 --task "Implement universal workflow"
   ```

2. **Wave Decomposition & Size Calibration**:
   - Tickets are organized in dependency waves.
   - Slices target a calibrated size budget of ~3,000 lines per ticket to ensure reviewability and maintain focus.
   - For T3 programs, each slice operates in its dedicated git worktree under `.tmp/worktrees/<slice-name>`.

3. **Live Orchestration Dashboard**:
   Monitor run progress, wave completion, status bars, and token budgets in real time:
   ```bash
   node tools/dashboard.mjs
   ```

4. **Test-Driven Feedback Loop (TDD)**:
   - Phase 1: Scientific bug reproduction or failing unit test first.
   - Phase 2: Run tests filtered through noise-reduction lens:
     ```bash
     node tools/test-lens.mjs run -- node --test tools/tests/u-quality.test.mjs
     ```
   - Phase 3: Minimal implementation following the Ponytail ladder (zero new dependencies, reuse existing utilities, stdlib first).
   - Phase 4: Confirm tests turn green.

5. **Intermediate Protocol Verification**:
   Verify that all required artifacts for the active tier are present and valid:
   ```bash
   node tools/workflow.mjs check
   ```

---

### Phase 3: Review & Acceptance (Качество, гейты и приёмка)

The goal of Review is strict verification: code quality gates, simplification, and independent acceptance.

1. **Stage B Simplification (Refactor with Frozen Tests)**:
   - Freeze Stage-A green test assertions:
     ```bash
     node tools/workflow.mjs stage-b --phase before --test-cmd "node --test tools/tests/u-quality.test.mjs"
     ```
   - Remove redundant abstractions, flatten unnecessary nesting, purge single-implementation wrappers.
   - Re-verify frozen tests stay 100% green:
     ```bash
     node tools/workflow.mjs stage-b --phase after --disposition simplified
     ```

2. **Automated Quality Gates (`check-ci`)**:
   Execute the full quality audit suite across the codebase:
   ```bash
   node tools/workflow.mjs check-ci --tier T2 --change <change-id>
   # or run quality gates directly:
   node tools/workflow.mjs check-ci --quality
   ```
   The gate enforces four strict checks:
   - `code-size`: file line count and function length limits via `tools/code-size.mjs`.
   - `debt-ledger`: inventory of deferred decisions and untriggered debt markers via `tools/debt-ledger.mjs`.
   - `logs-hygiene`: session log volume and age audit via `tools/doctor.mjs`.
   - `orphan-files`: detection and cleanup of abandoned temporary files or stray untracked files.

3. **Blind Oracle Acceptance**:
   Independent verification strictly against `manifest.md` requirements and runtime evidence:
   ```bash
   node tools/workflow.mjs artifact --kind oracle --detail "ACCEPT: all R## criteria verified against live runtime"
   ```

4. **Task Finalization**:
   Close the workflow run and record execution metrics:
   ```bash
   node tools/workflow.mjs close
   ```

---

## 3. Essential Command Summary

| Command | Purpose |
|---|---|
| `node tools/doctor-lite.mjs` | Fast (<2s) environment and harness diagnostic pre-flight |
| `node tools/workflow.mjs brief --rounds 3` | Interactive CLI briefing to generate requirements manifest |
| `node tools/workflow.mjs start --tier T2 --task "..."` | Initialize workflow task with governance tier |
| `node tools/dashboard.mjs` | Launch local live dashboard (waves, status, metrics) |
| `node tools/workflow.mjs check` | Verify task artifacts conformance |
| `node tools/workflow.mjs check-ci --quality` | Run code-size, debt-ledger, logs-hygiene, and orphan gates |
| `node tools/workflow.mjs close` | Seal task artifacts, record metrics, and clean state |
