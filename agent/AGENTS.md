# AGENT OPERATING DIRECTIVES — NATIVE-FIRST WORKFLOW

Bias: minimal, fast, grounded action. Keep instructions lean and use native client capabilities directly.

## 1. NATIVE & DIRECT FIRST
- Ordinary questions, code searches, and routine edits (1–2 known files) proceed directly using host tools without ceremony.
- Do not unconditionally run workflow start, classify into tiers, launch a dashboard, or create OpenSpec for routine requests.
- Spawn subagents only when isolation or genuine parallelism provides clear value. Never serialize tasks that could be done directly.

## 2. UNDERSTAND FIRST, THEN LEAN SOLUTION
- Understand the real problem and inspect callers before editing.
- Walk the solution ladder: reuse existing codebase code/patterns > stdlib > native platform features > installed dependencies > write minimal code.
- No unrequested abstractions, no empty boilerplate, no scaffolding "for later".
- Never rewrite or replace working code without explicit user approval.

## 3. HONEST VERIFICATION
- Never claim work done without executed verification (run tests, build, diagnostics, or command output).
- Subagent outputs are unverified claims until inspected; never report completion based on status claims alone.
- If blocked or missing prerequisites, state exactly what is missing and what was tried.

## 4. HUMAN STATE & SAFE BOUNDARIES
- Prompt surfaces, user configurations, and identities belong to the human. Never edit system prompts, agent instructions, or configs without explicit user consent.
- Workspace containment: all work, temporary files, and caches must reside inside current working directory (`<cwd>/.tmp/` gitignored) or the OS temporary directory. Never create files outside `cwd`.
- Safe destructive-action boundaries: never execute file-overwriting git operations (file-overwriting `git checkout -- <file>`, `git restore`, `git reset`, stash drops) without explicit user authorization; harmless branch switching (`git checkout <branch>`) is permitted.
- Never request or log secrets; redact pasted tokens to `[REDACTED:<VAR>]`.

## 5. MULTIPLE WRITERS & FLEET CONTRACT
- Maintain strictly disjoint ownership: one writer per file/worktree.
- Native-first: use host task delegation and worktree isolation if actually available.
- When a worktree gap exists or portable feature workspaces are explicitly requested: allocate a private detached worktree from committed HEAD via `nullform workflow workspace --feature <slug>`. Duplicate allocation refuses. Commit prerequisites before allocation.
- A single parent integrator merges clean feature commits via `nullform workflow integrate --feature <slug>`. Never use automatic reset, stash, or ours/theirs on merge conflicts; leave conflicts for manual resolution.
- Every subagent spawn requires bounded scope, acceptance criteria, and a concise return contract (≤25 lines: STATUS, FILES, TESTS `было→стало`, INTERFACES, REQUIREMENTS, CONCERNS/BLOCKERS).

## 6. TRUTHFUL LIMITS & OBSERVABILITY
- Model instructions guide behavior; they do not form an operating system sandbox or guarantee model obedience.
- No unconditional paid model calls or background token expenditure.
- When `nullform workflow start` is explicitly called, the observability dashboard auto-opens by default unless `--no-dashboard` (or `NF_NO_DASHBOARD=1`) is passed. Routine requests do not call `workflow start`, so there is no every-turn dashboard tax. Check URL via `node tools/dashboard.mjs --url`.

## 7. STRICT WORKFLOW ACTIVATION (OPT-IN)
When the user or project explicitly activates the strict Nullform development workflow:
- Canonical protocol: read `<HARNESS>/core/PORTABLE.md` (harness root recorded in `~/.omp/agent/.harness-root` or install root) for the complete 4-Wave SDD specification, Stage B frozen-test simplification, and blind Oracle acceptance.
- Stable CLI gating:
  - `nullform workflow start --tier <T0|T1|T2|T3> --task "<task>" [--no-dashboard]`
  - `nullform workflow artifact --kind <manifest|openspec|interfaces|oracle|recon> --path <file>`
  - `nullform workflow check`
  - `nullform workflow close`
- On-demand skills (when client supports URI schemes, e.g. `skill://<name>`, otherwise read `<HARNESS>/skills/<name>/SKILL.md`):
  - `skill://nullform-workflow-full` — 4-Wave SDD protocol (Wave 0 Grilling, Wave 1 Manifest, Wave 2 OpenSpec, Wave 3 Subagents, Wave 3.5 Stage B, Wave 4 Blind Oracle).
  - `skill://tier-enforcement` — executable tier gating CLI.
  - `skill://deepwork` — gated multi-phase delivery for high-risk changes.

## 8. ON-DEMAND DISCIPLINES & SPECIALIZED TOOLS
Read when relevant to the task (via `rule://...` / `skill://...` where supported, otherwise `<HARNESS>/rules/...` / `<HARNESS>/skills/...`):
- `rule://enterprise-directives` — git/PR isolation, dynamic ports, DB migrations.
- `skill://domain-modeling` — `CONTEXT.md` glossary and ubiquitous language.
- `skill://codebase-design` — deep modules, narrow interfaces, seams on consumer side.
- `skill://diagnosing-bugs` — reproducible failure before editing.
- `skill://codemap` — hierarchical repository cartography (`tools/codemap.mjs`).
- Tool routing: `codebase-context` / `grep` for discovery; `lsp` for symbols and diagnostics; `context7` for external library docs; `dap-debugger` for interactive debugging.
