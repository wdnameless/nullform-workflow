# Agent Integration Guide

Integrate the workflow into your project or foreign repository by delegating setup directly to your AI coding agent (Claude Code, Codex, Cursor, Hermes, OpenCode, OMP, or custom).

## How It Works

Paste the integration prompt to your agent. The agent audits your setup, determines the right adoption level (**L0..L3**), and produces an executable installation plan mapped to architecture slices (**S0..S4**).

```
[prompts/integration.md] ──(paste to agent)──> [Audit] ──> [Level L0..L3] ──> [Install Plan]
```

## Step-by-Step Instructions

1. **Copy the Prompt**:
   Copy the contents of `prompts/integration.md`.

2. **Paste into Your Agent's Session**:
   Start a chat or CLI session with your AI agent in your project root and paste the prompt.

3. **Get Environment Audit**:
   The agent inspects your repository non-destructively:
   - Detects active harness (`.claude/`, `.codex/`, `~/.omp/`, `~/.hermes/`, etc.)
   - Detects CI/CD configurations (`.github/workflows/`, GitLab CI, etc.)
   - Detects test runners, test suites, and scope
   - Detects existing quality gates and linters

4. **Review Recommended Level (L0..L3)**:
   The agent selects an adoption level:
   - **L0 (gates-only)**: 5 reusable quality gates (S0, S1).
   - **L1 (lanes+manifest)**: L0 + T0..T3 lanes and `manifest.md` requirements (S0, S1).
   - **L2 (full SDD)**: L1 + multi-agent roles, NEXUS escalation, Reality Checker oracle (S0, S1, S2).
   - **L3 (managed)**: L2 + guided CLI wizard (`nullform init`) and harness matrix (S0, S1, S2, S3, S4).

5. **Execute the Installation Plan**:
   Confirm the plan with your agent. The agent then runs `nullform init` (guided wizard) or executes the specific slice configuration commands.

## References
- Architecture Slices & Levels: `docs/SLICES.md`
- Quality Gates Reference: `docs/GATES.md`
- Portable Core Specification: `core/PORTABLE.md`
