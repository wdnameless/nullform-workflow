# Universal Workflow Integration Prompt

Copy and paste the prompt below into your AI agent's chat session:

---

```text
You are an expert systems integrator. Audit this repository and prepare an integration plan for the portable workflow architecture.

### Phase 1: Environment Audit
Audit the workspace non-destructively:
1. Detect AI Harness: Inspect for Claude Code (.claude/), Codex (.codex/), Hermes (~/.hermes/), OMP (~/.omp/), Cursor (.cursor/), OpenCode, or custom setup.
2. Detect CI/CD: Inspect .github/workflows/, .gitlab-ci.yml, or other CI runners.
3. Detect Tests: Identify test runner (npm test, pytest, cargo test), test directory, and scope.
4. Detect Quality Gates: Check existing lint, coverage, mutation, or size guards.

### Phase 2: Integration Level Selection (L0..L3)
Pick the target adoption level based on repository needs (reference: docs/SLICES.md):
- L0 (gates-only): Choose if the project needs automated quality gates (5 gates: mutation, coverage, clone, code-size, quality) in CI/local without changing development processes. Slices: S0, S1. (Reference: docs/GATES.md).
- L1 (lanes+manifest): Choose if the project needs task tiering (T0..T3 lanes) and atomic requirement tracing (manifest.md R##) alongside quality gates. Slices: S0, S1.
- L2 (full SDD): Choose if the team uses multi-agent workflows and requires 4-Wave Spec-Driven Development, Stage B simplification, reviewer NEXUS escalation, and blind oracle acceptance. Slices: S0, S1, S2.
- L3 (managed): Choose if the project requires the guided CLI installation wizard, multi-harness matrix integration, and managed fleet capabilities. Slices: S0, S1, S2, S3, S4.

### Phase 3: Installation Plan via Wizard Steps
Present a structured report with:
1. Audit Findings: Detected harness, CI runner, test commands, and root path.
2. Recommended Level: Chosen level (L0..L3) with rationale.
3. Target Slices: Architecture slices (S0..S4) required for the chosen level.
4. Wizard Execution Plan:
   - Guided interactive install: run `nullform init` (walks Flow -> Harness -> Slices -> Dry-run -> Confirm; enter `..` to step back).
   - Non-interactive / dry-run: run `nullform init --dry-run --harness <id>`.
   - Foreign gates-only (L0): run gates via `node <path>/tools/mutation-changed.mjs --root .` or `nullform quality`.
5. Next Steps: Request user confirmation before writing configuration.
```

---

## References
- Architecture Slices: [docs/SLICES.md](../docs/SLICES.md)
- Quality Gates: [docs/GATES.md](../docs/GATES.md)
- Integration Guide: [docs/AGENT-INTEGRATION.md](../docs/AGENT-INTEGRATION.md)
