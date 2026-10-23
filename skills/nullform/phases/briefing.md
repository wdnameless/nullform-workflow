# Phase 1: Briefing

Interactive context gathering, requirements atomization, and pre-flight health diagnostics before code modification.

## Key Objectives
- Eliminate ambiguity before implementation begins.
- Atomize operator requirements into unambiguous `R##` entries with verbatim quotes.
- Verify environment and harness health with fast pre-flight probes.

## Core Commands & Workflow

1. **Pre-flight Health Probe**:
   ```bash
   node tools/doctor-lite.mjs
   ```
   Verifies Node.js version (>=18), harness configuration, tool syntax, and skills-lock integrity in under 2000ms.

2. **Interactive Briefing Rounds**:
   ```bash
   node tools/workflow.mjs brief --rounds 3
   ```
   Conducts structured operator interviews to clarify constraints, trade-offs, and acceptance targets. Records answers into `openspec/changes/<change>/manifest.md`.

3. **Requirement Atomization (`R##`)**:
   - Each requirement receives a stable identifier (`R01`, `R02`, etc.).
   - Records verbatim operator intent and concrete, observable acceptance criteria.

4. **Tier Selection**:
   - **T0**: Trivial fix (1–2 known files, no ceremonies).
   - **T1**: Lean change requiring reconnaissance note (`recon.md`).
   - **T2**: Formal change with full OpenSpec artifacts (`manifest.md`, `proposal.md`, `tasks.md`, `specs/`, `interfaces.md`, `oracle.md`).
   - **T3**: Multi-slice initiative requiring isolated git worktrees (`worktrees.md`).
