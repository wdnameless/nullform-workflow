---
description: "On-demand enterprise directives: vertical-slice architecture, enterprise git/PR isolation protocol, dynamic port allocation, reproducible DB migrations, visual QA timing, secrets redaction gate. Read before git branch/PR work, DB schema changes, dev-server startup, Playwright screenshots, or new external deps."
---

# Enterprise Engineering Directives & Core Architectural Philosophy

> On-demand rule. The orchestrator reads this when the task touches: DB schema, git branch/PR workflow, dev-server ports, Playwright screenshots, or new external dependencies. Not auto-loaded into sessions.

## 1. Architectural Philosophy: Elegant, Sliced & Decoupled Design
- **Vertical Slice Architecture & Decoupled Services**:
  - Always design features as independent, isolated vertical slices (Domain/Feature Slices) or decoupled services.
  - Features must function autonomously without tight coupling; modifying one slice must NEVER break or destabilize adjacent modules.
- **Clean, Minimal & Scalable Craft**:
  - Prioritize elegance, optimal performance, and clean code over over-engineered complexity.
  - Adopt proven modern engineering patterns (Dependency Inversion, Strict Contract Interfaces, Event-Driven / Unidirectional State).

## 2. Enterprise Git Workflow: Isolated Feature Branches & PR Quality Gates
- **Trunk-Based Isolation Protocol**:
  - **NEVER work directly in `main` / `master`** for non-trivial tasks (T1â€“T3). The `main` branch is strictly production-ready code.
  - For every new feature, refactoring, or bugfix created via OpenSpec:
    1. **Branch Creation**: Create a dedicated short-lived feature branch using semantic naming:
       - `feat/<feature-name>` (e.g. `feat/auth-sessions`, `feat/courses-catalog`)
       - `fix/<bug-name>` (e.g. `fix/cart-storage-sync`)
       - `refactor/<scope>` (e.g. `refactor/api-client-slice`)
    2. **Isolated Worktrees**: Use Git Worktrees / isolated lanes to isolate subagents (@designer, @fixer) in dedicated workspace directories without dirtying the main working tree.
    3. **Atomic Conventional Commits**: Make small, focused commits during implementation (`feat(slice): ...`, `test(slice): ...`).
    4. **PR Verification Gate**: Before merging into `main`:
       - Run full CI checks locally (`typecheck`, `lint`, `test`).
       - Ensure 100% diff test coverage via `test-gap`.
       - Conduct blind acceptance verification via `@oracle`.
    5. **Clean Merge & Prune**: Perform a clean merge (Squash or Rebase Merge) into `main` and immediately delete the merged feature branch.

## 3. Dynamic Port Allocation & Dev-Server Safety
- **Port Collision Prevention**:
  - NEVER assume default ports (3000, 5173, 8080) are free.
  - Before starting any dev-server, mock server, or preview instance:
    1. Check if the target port is currently occupied (`netstat -ano | findstr :<port>` or bash equivalent).
    2. If the port is in use, DO NOT crash or blindly kill processes. Instead, dynamically allocate the next available free port (e.g. 5174, 5175, 3001).
    3. Pass the exact allocated dynamic URL/port directly to Playwright MCP and preview runners.

## 4. Database State & Reproducible Migrations
- **Zero Database Drift**:
  - Any schema change, table creation, or column addition (via Supabase or local DB) MUST be paired with an idempotent SQL migration file in `supabase/migrations/<timestamp>_<name>.sql` or `migrations/`.
  - Prohibit unrecorded manual schema edits in live environments.

## 5. Visual QA & Hydration Timing Standards
- **Stable Rendering Capture**:
  - When taking Playwright screenshots, always await full font loading and hydration (`document.fonts.ready`, `networkidle` or `data-hydrated="true"`).
  - Add a 300ms debounce before screenshot capture to avoid grabbing mid-animation states (e.g. Framer Motion transitions with opacity < 1.0).

## 6. Proactive Critique & Best-in-Class Solutions
- **Intellectual Honesty & Constructive Critique**:
  - Never fabricate output, lie about test results, or invent unverified facts.
  - If a user's initial proposal or technical requirement has architectural flaws, security risks, or scalability bottlenecks, **proactively critique it constructively** and propose a measurably superior, modern alternative during the Grilling phase.

## 7. Zero Context Loss & Proactive Delegation
- **Context Protection Guarantee**:
  - Never allow context degradation or hallucination due to task size.
  - Whenever a task begins to expand or exceeds single-lane comprehension, **immediately slice and delegate** bounded sub-tasks to specialized subagents (@designer, @fixer, @explorer) using Typed Yield contracts and OpenSpec anchors (`proposal.md`, `specs/`).

## 8. Codebase Navigation & External API Verification
- In repositories with `.codegraph/`: reach for `codegraph_explore` (MCP) before raw grep/find to trace dynamic call paths.
- Always verify external library API types and signatures via **Context7 MCP** before importing new dependencies.
- Maintain strict `.env.example` parity without leaking production secrets.
- Ensure `openspec/archive/` is excluded from general codebase grep queries to prevent spec noise.

## 9. Secrets Redaction Gate (ingest-time, before any file write)
- Never request credentials. *Which* provider is a question; the value never is.
- Every pasted fragment is scanned before it reaches a file/prompt: `sk-â€¦`, `ghp_â€¦`, `AKIAâ€¦`, `AIzaâ€¦`, `xoxb-â€¦`, JWT (`eyJâ€¦`), connection strings with passwords, `-----BEGIN â€¦ PRIVATE KEY-----`, â‰¥32-char hex/base64 next to Â«key/token/secret/ÐºÐ»ÑŽÑ‡/Ñ‚Ð¾ÐºÐµÐ½/Ð¿Ð°Ñ€Ð¾Ð»ÑŒÂ».
- On hit: value â†’ `[REDACTED:<VAR_NAME>]`, name added to `.env.example` empty, user told in one line, value NEVER echoed back.
- A secret that reached a file or commit = stop condition: report immediately, advise rotation.
- Machine-local note: `~/.omp/` and `~/.paseo/` contain live API keys in plaintext (models.yml, mcp.json). NEVER include them in external shares, uploads, or backup bundles.

## 10. Workflow Discipline â€” authoritative sources

Sections previously duplicated here now live in exactly one place each. Read the source, not a copy:

| Topic | Authority |
|---|---|
| Lane classification, wave protocol, tool budget | `D:/tmp/e3/harness/agent/agents/orchestrator.md` |
| Context hygiene (checkpoint/rewind in recon) | `orchestrator.md` Â§ T2 Wave 1 + `skill://codemap` |
| Deep modules, seams, deletion test | `skill://codebase-design` |
| Ubiquitous language, `CONTEXT.md`, ADRs | `skill://domain-modeling` |
| Scientific 6-phase bug diagnosis | `skill://diagnosing-bugs` + `agent/agents/fixer.md` |
| Expandâ€“Contract for wide refactors | `orchestrator.md` Â§ Wave 2 |
| Runtime Oracle acceptance | `agent/agents/oracle.md` |
