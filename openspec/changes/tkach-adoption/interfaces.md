# Interfaces and ownership — tkach-adoption

## tools/prompt-lint.mjs — new subcommand (frozen)
`node tools/prompt-lint.mjs sizes [--root <dir>] [--json] [--check]`
- Groups + entries: `always` = `agent/AGENTS.md`; `role-defs` = `agent/agents/*.md`; `rules` = `<root>/rules/*.md` + installed `~/.agents/rules/*.md`; `skills` = repo `skills/*/SKILL.md` (or installed `~/.agents/skills/*/SKILL.md` when present) measured by **frontmatter name+description bytes** (the registry cost), not the whole file; `always` also reported with total bytes/lines.
- Budgets (defaults; `.prompt-lint/budget.json` may override any key, partial merge): `{ alwaysMaxBytes: 16384, alwaysMaxLines: 240, roleDefMaxBytes: 32768, skillsRegistryMaxBytes: 40960 }`.
- Text output: one line per surface (`path  bytes  lines`), then `budget: OK|VIOLATION` lines per budget (`lines 205/240`, `bytes 9.7/16.0 KB`); exit 0 normally, exit 1 with `--check` on any violation.
- JSON: `{groups:[{name,files:[{path,bytes,lines}],totals:{files,bytes,lines}}], budgets:{...}, violations:[{key,actual,limit,unit}]}`.
- Existing `scan`/`baseline`/`check`/`fingerprint` commands keep their behaviour byte-for-byte.

## tools/usage-audit.mjs (new; zero deps, RU output, context-inbox conventions)
`node tools/usage-audit.mjs [--sessions <dir>] [--days N] [--top N] [--mcp <path>] [--skills <dir>] [--json]`
- Defaults: sessions `$HOME/.omp/agent/sessions` (recursive `*.jsonl`), mcp `$HOME/.omp/agent/mcp.json`, skills `$HOME/.agents/skills`, days 30, top 15.
- Parses each JSONL line; extracts tool names from `tool_use` blocks (both `name` fields and nested content arrays), counts `skill://<name>` occurrences in stringified arguments (bounded: only scan `"input"` fields, max 4 KB per call).
- Sections (RU): `MCP-инструменты` (names starting `mcp__`, ranked, count) · `Встроенные` (all others, ranked) · `Скиллы` (skill:// reads ranked) · `Неиспользуемые MCP-серверы` (keys of `mcpServers` never matching any tool name) · `Неиспользуемые скиллы` (installed dirs never referenced) · `Заметки` (files scanned, period, malformed line count).
- No sessions dir → `Сессий не найдено: <path>` exit 0. Never prints message text; only tool/skill names and counts. `--json`: `{scanned:{files,lines,malformed},windowDays, mcpTools:[{name,count}], builtins:[…], skills:[…], unusedMcpServers:[…], unusedSkills:[…]}`.

## tools/domain-context.mjs — DECISIONS section (additive)
- After RECENT COMMITS: scan (case-insensitive token match, bounded ≤5 rows, first matching line, 160-char trim) `docs/adr/**/*.md` and `openspec/changes/**/{proposal,manifest}.md`; heading `DECISIONS`; empty → `решений по домену не найдено`; never fails the run.

## tools/doctor.mjs (new; zero deps, RU output)
`node tools/doctor.mjs [--harness <dir>] [--agent-dir <dir>] [--agents-home <dir>] [--json] [--quiet]`
- Defaults: `--harness` = parent of the tools/ dir containing this script; `--agent-dir` = `$HOME/.omp/agent`; `--agents-home` = `$HOME/.agents`.
- Mode: `installed` when `<agent-dir>/.harness-root` exists (full checks), else `repo` (agent-dir checks degrade to WARN with an explicit note).
- Checks (id → what): `node` (version ≥18) · `harness-files` (agent/AGENTS.md, agent/agents/*.md ≥8, rules/enterprise-directives.md, core/PORTABLE.md, CONTEXT.md, README.md, templates/, paseo/) · `tools-syntax` (`node --check` for every `tools/*.mjs`; required core set present: workflow, prompt-lint, skills-doctor, glossary, replay, codemap, return-contract, cache-policy, cache-doctor, context-inbox, domain-context, oracle-model, debt-ledger, benchmark, usage-audit, auto-review, doctor, audit.ps1, sync.ps1) · `tools-smoke` (`prompt-lint fingerprint --root <harness>` exit 0; `debt-ledger scan --root <fresh tmp dir>` exit 0) · `agent-wiring` (`<agent-dir>/AGENTS.md` exists AND contains the harness path; `.harness-root` content equals harness; `<agent-dir>/agents` lists ≥8 role files; `<agent-dir>/rules/enterprise-directives.md` exists; `<agents-home>/rules/enterprise-directives.md` exists) · `skills` (spawn `skills-doctor.mjs --installed <agents-home>/skills --repo <harness>/skills`, exit 0; report counts) · `prompt-baseline` (`.prompt-lint/baseline.json` exists under harness AND `prompt-lint check --root <harness>` exit 0; missing baseline → WARN) · `configs` (if `mcp.json`/`models.yml`/`config.yml` exist in agent-dir: mcp.json must JSON-parse; models/config presence reported; NEVER print values).
- Statuses: `pass|fail|warn|skip`; `ok = (fail === 0)`; exit 0/1 accordingly. JSON: `{mode,harness,agentDir,checks:[{id,status,detail}],summary:{pass,fail,warn,skip},ok}`.
- Never mutates anything. `--quiet` prints only the summary line.

## Wiring (owner: W worker)
- `tools/sync.ps1`: manifest += `'tools\usage-audit.mjs',` and `'tools\doctor.mjs',`.
- `tests/test-portability.ps1`: asserts both install.
- `tools/audit.ps1`: += `Invoke-Check 'usage audit tool'` (presence) · `Invoke-Check 'install doctor'` (run `node tools/doctor.mjs --harness <HarnessRoot> --json`, expect exit 0; when `$HOME/.omp/agent/.harness-root` missing → Detail `n/a (no installed agent dir)`, Ok=$true) · `Invoke-Check 'prompt budget'` (run `node tools/prompt-lint.mjs sizes --root <HarnessRoot> --check`, exit 0).
- `verify.ps1`: += `Check 'install doctor (repo mode)'` — run `node tools/doctor.mjs --harness <repo> --json` and require exit 0 (repo mode allows WARN) plus JSON parses.
- `install.ps1`: after the baseline step, run `node "$HarnessRoot\tools\doctor.mjs" --harness "$HarnessRoot" --agent-dir "$agentDir" --agents-home "$agentsHome"`; on non-zero exit → print the FAIL lines and `exit 1` (install must not report success when the tree is incomplete).

## Prompt surfaces (owner: A worker; intents frozen)
- `agent/agents/orchestrator.md`: **STAGE B** rule (after Wave 3 green, before Wave 4: one simplification iteration per code slice; input = lean delete-list or `skill://simplify`; stage-A tests unchanged and re-run; report `net: -N lines`) · **CONTEXT PACK** checklist in Wave 1 (brief verbatim, discussion transcript, DB schema + sample rows, prod logs/trace, git history of touched paths, ADR/decisions) + noise rule (drop stale/global noise rather than adding volume; missing source → context-inbox) · memory hygiene line.
- `agent/agents/fixer.md`: `<stageB>` block — simplification mode: tests frozen, flatten nesting, remove single-implementation abstractions/dead flexibility, keep never-cut list, no new dependencies.
- `agent/agents/reviewer.md`: one line — the tagged delete-list is the Stage B input.
- `agent/AGENTS.md`: **PROMPT-OWNERSHIP** law bullet (prompt surfaces are human-owned; agent edits only after explicit user approval) + memory-hygiene lines (retains ≤ ~200 words structured; durable architecture decisions → `docs/adr/`, not memory). Keep the file within the R02 budget (≤16 KB / ≤240 lines).

## Docs (owner: F worker)
- `README.md`: Stage B flow paragraph · «Бюджет промптов (`sizes`)» · «Аудит использования (`usage-audit`)» · «Проверка установки (`doctor`)» with commands incl. re-run after install.
- `CONTEXT.md`: terms **Stage B**, **Prompt budget**, **Usage audit**, **Install doctor**.

## Ownership (one writer per file)
- A (task): agent/agents/orchestrator.md · agent/agents/fixer.md · agent/agents/reviewer.md · agent/AGENTS.md
- B (fixer): tools/prompt-lint.mjs · tools/tests/prompt-cache.test.mjs
- C (fixer): tools/usage-audit.mjs · tools/tests/usage-audit.test.mjs · tools/domain-context.mjs · tools/tests/domain-context.test.mjs
- D (fixer): tools/doctor.mjs · tools/tests/doctor.test.mjs
- E (fixer): tools/sync.ps1 · tools/audit.ps1 · verify.ps1 · tests/test-portability.ps1 · install.ps1
- F (task): README.md · CONTEXT.md
- Main: openspec artifacts · integration (baselines, suites, verify/audit/portability, install smoke) · oracle · git
