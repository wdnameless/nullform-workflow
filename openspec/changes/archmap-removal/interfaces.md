# Interfaces and ownership — archmap-removal

## Deleted (repo)
- tools/archmap.mjs · archmap-analysis.mjs · archmap-problems.mjs · archmap-cache.mjs · archmap-report.mjs · archmap-demo.mjs
- tools/report/** (client.js, client.core.js, client.graphs.js, client.problems.js, page.css)
- tools/tests/archmap-analysis.test.mjs · archmap-problems.test.mjs · archmap-report.test.mjs
- tools/package.json · tools/package-lock.json (typescript was archmap-only)
- skills/architecture-observability/** (whole skill dir)
- (Main) repo `.archmap/`; harness-root copies under D:/ohmypi/tools/; `~/.agents/skills/architecture-observability`

## auto-review.mjs — frozen contract after slimming
- CLI unchanged: `node tools/auto-review.mjs [--root <dir>]`; Russian report; never edits code.
- Sections in order: 1) tsc --noEmit (only if tsconfig.json; report-only) · 2) ESLint (only if config; report-only) · 3) `npm test` (only if package.json has a test script; **failure → gate**) · 4) debt ledger: `node <toolsDir>/debt-ledger.mjs scan --root <root> --check` (**exit 1 → gate**).
- Exit 0 = all gates pass; exit 1 = at least one gate failed; failure reasons printed as a list.
- Removed: `ensureArchmapScan`, `.archmap` state/previous reads, cycles/problems counting, DIR/STATE/PREV constants.
- tools/tests/auto-review.test.mjs updated to the new semantics (clean fixture → 0; fixture with a `defer:` marker lacking `upgrade:` → 1; no archmap fixtures).

## verify.ps1 / audit.ps1 / sync.ps1 / install.ps1 / portability / CI
- verify.ps1: delete every archmap check (scan/cycle/report/json renderer checks). The auto-review check keeps its name but the fixture becomes: clean dir → auto-review exit 0; dir with a no-trigger `defer:` marker in a .js file → exit 1 (gate). Detail string reports both codes.
- audit.ps1: delete the `architecture report engine` check; keep the rest.
- sync.ps1: remove the manifest entries for archmap*.mjs (5), report/* (4), archmap-demo.mjs, package.json, package-lock.json (12 lines). Nothing else changes.
- install.ps1: remove the `npm ci --prefix tools` step and the tools-dependency block; update the "node not found" message and the header comment that lists archmap among the tools.
- tests/test-portability.ps1: remove asserts about `tools\report\*` and `tools\tests\archmap-report.test.mjs`; add negative asserts: `-not (Test-Path ... tools\archmap.mjs)` and `-not (Test-Path ... tools\report)`; keep the debt-ledger assert.
- .github/workflows/repo-gate.yml and templates/ci/workflow-gate.yml: remove `npm ci --prefix tools`, the archmap scan step, and the `.archmap` artifact upload; keep tests, openspec validate, auto-review, workflow-state check.

## Prompts & docs
- agent/AGENTS.md: delete the whole "1b. ARCHITECTURE VISIBILITY" section (and any leftover archmap mention).
- agent/agents/orchestrator.md: delete the archmap report block; keep the rest of the lane definitions intact.
- README.md: delete «Карта архитектуры» section, archmap rows in the tools list, and archmap wording in the CI section.
- CONTEXT.md: remove archmap references if present (grep; currently none expected).
- .gitignore: drop `.archmap/` and `archmap-demo/`.

## Intentional survivors (do NOT "clean")
- `.archmap` entries inside the ignore arrays of tools/debt-ledger.mjs and tools/domain-context.mjs — defensive skip for legacy output dirs of scanned user projects.
- openspec/changes/** history mentions.

## Ownership (one writer per file)
- Worker A (fixer): the deletions under tools/ + tools/auto-review.mjs + tools/tests/auto-review.test.mjs
- Worker B (fixer): verify.ps1 · tools/audit.ps1 · tools/sync.ps1 · install.ps1 · tests/test-portability.ps1 · .github/workflows/repo-gate.yml · templates/ci/workflow-gate.yml · .gitignore
- Worker C (task): agent/AGENTS.md · agent/agents/orchestrator.md · README.md · CONTEXT.md · skills/architecture-observability/**
- Main: openspec artifacts · deployed-copy deletion · baselines · suites · oracle · git
