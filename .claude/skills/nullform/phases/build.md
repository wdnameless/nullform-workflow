# Phase 2: Build

Disciplined, test-driven implementation waves with calibrated ticket sizing and real-time observability.

## Key Objectives
- Execute implementation strictly against declared requirements.
- Maintain a rapid Red-Green-Refactor feedback loop.
- Keep task sizes calibrated to ~3,000 lines per slice budget.

## Core Commands & Workflow

1. **Task Initialization**:
   ```bash
   node tools/workflow.mjs start --tier <tier> --task "<description>"
   ```
   Opens the active workflow lane and declares tier governance.

2. **Live Orchestration Dashboard**:
   ```bash
   node tools/dashboard.mjs
   ```
   Launches real-time tracking of wave execution, ticket statuses, time tracking, and token budgets.

3. **Noise-Filtered TDD Loop**:
   ```bash
   node tools/test-lens.mjs run -- node --test <test-file>
   ```
   Filters verbose test output down to actionable failures and summary counts (`было N → стало M`).

4. **Implementation Discipline (Ponytail Ladder)**:
   - Reuse existing codebase utilities and stdlib before introducing abstractions.
   - Zero unnecessary external dependencies.
   - Maintain security boundaries, data integrity, and validation invariants.

5. **Artifact & Protocol Conformance**:
   ```bash
   node tools/workflow.mjs check
   ```
   Validates required artifacts for the active tier before proceeding to review.
