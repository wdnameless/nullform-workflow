# Interfaces and ownership — context-pipeline

## context-inbox.mjs (project-side tool)
- Root: `<project>/context/` with fixed categories: `design`, `architecture`, `domain`, `product`, `ops`, `other`.
- `init` — create `context/` + category dirs + `README.md` (explains the loop) + empty `REQUESTS.md`. Idempotent; never overwrites existing files.
- `request --category <c> --need "<what>" [--why "<why>"] [--hint "<where user might find it>"]` — appends a row to `context/REQUESTS.md`, prints the id + the drop path.
- `list [--json]` — open requests + per-category inventory (file names, count). JSON: `{requests:[{id,category,need,why,status,added}], inventory:{category:[files]}}`.
- `resolve --id <id> [--file <name>]` — marks row `done` (+ optional file ref).
- `check [--strict]` — validates REQUESTS.md structure (columns, ids unique); exit 1 only on structural malformation or with `--strict` when open requests exist; default exit 0 with advisory count.
- REQUESTS.md format: markdown table `| ID | Category | Needed | Why | Status | Added |`; ids `c1, c2, ...`; status `open|done`.
- Zero deps, Node 18+, works from any cwd via `--root`.

## domain-context.mjs
- `node tools/domain-context.mjs --domain <name> [--root .] [--json] [--max-files 15]`.
- Collects: (1) files whose path contains the domain token (case-insensitive) OR listed in `.codemap/state.json` for a folder matching the domain; (2) `git log --oneline -8 -- <paths>` (skip when not a repo); (3) related open issues via `gh issue list --search "<domain>" --limit 5` ONLY when `gh` exists and repo has a remote; every source degrades to a note, never fails the run.
- Output (RU text or JSON): sections FILES / RECENT COMMITS / ISSUES / NOTES(limitations). Bounded: max 15 files, truncation noted. Exit 0 always unless `--domain` missing (exit 2).

## oracle-model.mjs
- `list [--json]` — priority entries, availability (declared models from models.yml; with `--probe` also discovery providers via GET {baseUrl}/models, 10s timeout, key from models.yml, NEVER printed), current oracle role from config.yml, resolved pick.
- `apply [--config path] [--models path] [--priority path] [--probe] [--dry-run]` — resolve first priority match among available; fallback chain ends with `gemini-3.8-flash-high`; write `modelRoles.oracle` and `task.agentModelOverrides.oracle` (targeted line replacement preserving the rest of the file byte-for-byte); print what changed. Exit 0 on success/idempotent, 1 when nothing resolvable.
- `ensure` — `apply` only if current oracle != resolved pick; idempotent, quiet success line. Used by orchestrator before oracle spawn.
- Priority file: `agent/oracle-priority.example.json` in repo (shipped), live override `$HOME/.omp/agent/oracle-priority.json`. Schema: `{version:1, entries:[{match:"substring", why:"..."}]}`; match is case-insensitive substring against `<provider>/<model>`; last entry is the fallback.
- Default models.yml/config.yml paths: `$HOME/.omp/agent/`. `--root` not used; explicit flags only.
- Secrets: apiKey read for probing only; any output must pass through a redactor (never echo key material).

## Prompt surfaces (designer owns)
- `agent/AGENTS.md`: CONTEXT-GAPS rule (one line pair) under laws.
- `agent/agents/orchestrator.md`: Wave 1 — read `context/` inventory + open requests via `context-inbox list`; Wave 2 — human-plan rule; Wave 4 — run `oracle-model ensure` before oracle spawn.
- `agent/agents/reviewer.md`: "Simplest solution" lens.
- `agent/config.yml.example`: comments for oracle-different-model + oracle-priority.
- `skills/media-context/SKILL.md`: new skill (frontmatter name+description; pipeline; fallbacks; privacy; output into context/).

## Ownership
- Worker1 (fixer): tools/context-inbox.mjs, tools/domain-context.mjs, tools/tests/context-inbox.test.mjs, tools/tests/domain-context.test.mjs
- Worker2 (fixer): tools/oracle-model.mjs, agent/oracle-priority.example.json, install.ps1, tools/audit.ps1, tools/tests/oracle-model.test.mjs
- Worker3 (designer): skills/media-context/SKILL.md, agent/AGENTS.md, agent/agents/orchestrator.md, agent/agents/reviewer.md, agent/config.yml.example
- Main: specs, sync.ps1 manifest, tests/test-portability.ps1 assertions, baseline, integration, git.
