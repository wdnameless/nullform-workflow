# Phase 3: Review & Acceptance

Automated quality gates, Stage-B simplification, and evidence-grounded independent verification.

## Key Objectives
- Refactor without regression under frozen test suites.
- Pass automated quality gates for code size, debt ledger, logs hygiene, and orphan cleanup.
- Seal the task with independent, evidence-backed oracle verification.

## Core Commands & Workflow

1. **Stage-B Simplification**:
   - Freeze Stage-A green assertions:
     ```bash
     node tools/workflow.mjs stage-b --phase before --test-cmd "<test-command>"
     ```
   - Strip redundant abstractions, flatten excessive nesting, and clean speculative options.
   - Re-verify frozen suite:
     ```bash
     node tools/workflow.mjs stage-b --phase after --disposition simplified
     ```

2. **Quality Gates (`check-ci`)**:
   ```bash
   node tools/workflow.mjs check-ci --quality
   ```
   Enforces four non-negotiable gates:
   - **code-size**: File line counts and function length limits.
   - **debt-ledger**: Audits deferred decisions and untriggered debt markers.
   - **logs-hygiene**: Verifies session log volume and age boundaries.
   - **orphan-files**: Detects stray untracked files or abandoned temporary artifacts.

3. **Blind Oracle Acceptance**:
   ```bash
   node tools/workflow.mjs artifact --kind oracle --detail "ACCEPT: all R## criteria verified against live runtime"
   ```
   Conducts objective verification strictly against `manifest.md` requirements and runtime evidence.

4. **Task Finalization**:
   ```bash
   node tools/workflow.mjs close
   ```
   Records execution metrics, seals artifacts, and closes the active lane.
