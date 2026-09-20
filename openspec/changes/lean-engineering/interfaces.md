# Interfaces and ownership — lean-engineering

## Marker convention (frozen)
Single line, inside a comment (`// # -- ; /* * <!--` accepted):

    defer: <what was simplified> | ceiling: <limit kept> | upgrade: <trigger to revisit>

- `defer:` starts the marker; `ceiling:` and `upgrade:` are keyword fields anywhere after it on the SAME line (pipe separators optional).
- Missing `upgrade:` → `no-trigger` (rot risk). That is the only thing that becomes an archmap problem.
- Markdown is never scanned (prose that documents the convention must not self-trigger).

## tools/debt-ledger.mjs (new; zero deps, Node 18+, ESM)
Library exports (frozen — archmap imports the first two):
- `export const DEFAULT_MARKER = "defer"`
- `export function parseMarkerLine(line, marker = DEFAULT_MARKER)` → `{what, ceiling, upgrade, noTrigger, raw}` | `null`
- `export function scanText(text, file, marker = DEFAULT_MARKER)` → `Array<{file, line, what, ceiling, upgrade, noTrigger, raw}>`
- `export function scanRepo(root, { marker = DEFAULT_MARKER } = {})` → `{root, markers, byFile: {file: markers[]}, total, noTrigger}`
- `export function formatLedger(result)` → string (RU, grouped by file)
- `export function parseArgs(argv)` (context-inbox convention)

CLI: `node tools/debt-ledger.mjs scan [--root <dir>] [--json] [--check] [--write <file>] [--marker <key>]`
- default `scan`: human ledger; per line `<file>:<line> — <what> | ceiling: … | upgrade: …`; summary `<N> маркеров, <M> без триггера.`; empty → `Чисто: отложенных упрощений нет.`
- `--json`: `{root, total, noTrigger, byFile}`.
- `--check`: exit 1 when `noTrigger > 0`, else 0 (CI gate).
- `--write <file>`: deterministic markdown ledger, grouped by file with a summary row.
- Scan scope: text code extensions only (js/mjs/cjs/ts/tsx/jsx/py/go/rs/java/kt/cs/c/cpp/h/rb/php/swift/sql/sh/ps1/vue/svelte/lua/…); skip `node_modules .git dist build out coverage vendor __pycache__ .venv .archmap target`; skip files >1 MiB or containing NUL in the first 8 KiB; sorted, deterministic output.
- Exit 0 unless the command itself fails (`--check` semantics above).

## tools/archmap-problems.mjs (edit)
- `import { scanText } from "./debt-ledger.mjs";` — ONLY this import crosses the boundary.
- New detector `detectDebtProblems(state, sourceGetter)` returning the existing problem shape: `{id: makeProblemId("maintainability","debt-no-trigger",file,line), severity:"low", category:"maintainability", kind:"debt-no-trigger", title, why, fix, where:[{file,line}], prompt}` — one problem per no-trigger marker; `sourceGetter(file)` null → skip.
- Registered in `analyzeProblems` beside the other detectors; ordering/severity semantics unchanged. HTML/JSON rendering rides the existing generic path (no client edits).

## Prompt surfaces (frozen wording intent, editor decides exact phrasing)
- `agent/agents/fixer.md`: `<ladder>` block — 7 rungs, "runs after understanding, never instead", two-rungs-work→take-higher, never-cut list, bug-report=root-cause (grep callers), deliberate shortcut → `defer:` marker (names the tool).
- `agent/agents/designer.md`: ladder under Implementation step 1 — native platform over libraries (native inputs, CSS over JS), installed deps over new ones, never cut accessibility/states; `defer:` marker line.
- `agent/agents/reviewer.md`: lens block — tagged findings (`delete:/stdlib:/native:/yagni:/shrink:`), mandatory replacement, `net: -N lines possible` / `Lean already.`, minimum test never flagged, correctness untouched.
- `agent/agents/orchestrator.md`: LAW 2 gains one ladder+marker line; Wave 4 gate mentions the `net:` metric.
- `agent/AGENTS.md`: one LEAN-FIRST law bullet (ladder + never-cut + defer marker + tool name).
- `CONTEXT.md`: *Solution ladder*, *Defer marker*, *Debt ledger* (+ tooling entry).
- `README.md`: section «Бережливая разработка» — ladder, marker grammar, review tags, CLI examples.

## PowerShell wiring (one owner)
- `tools/sync.ps1`: manifest entry `'tools\debt-ledger.mjs',` (near the other tools).
- `tests/test-portability.ps1`: assert debt-ledger.mjs installs.
- `tools/audit.ps1`: `Invoke-Check 'debt ledger tool'` — present in HarnessRoot (fail when missing, mirror 'architecture report engine').
- `verify.ps1`: check 'debt ledger gate works' — tmp fixture with a no-trigger marker → `scan --check` exit 1; marker with `upgrade:` → exit 0; `--json` parses.

## Ownership (one writer per file)
- Worker1 (fixer): tools/debt-ledger.mjs · tools/tests/debt-ledger.test.mjs
- Worker2 (fixer): tools/archmap-problems.mjs · tools/tests/archmap-problems.test.mjs
- Worker3 (task): agent/agents/{fixer,designer,reviewer,orchestrator}.md · agent/AGENTS.md · CONTEXT.md · README.md
- Worker4 (fixer): tools/sync.ps1 · tools/audit.ps1 · verify.ps1 · tests/test-portability.ps1
- Main: openspec artifacts · integration (sync deploy, baseline, suites, archmap self-scan) · git
