# Requirements — archmap removal (T2)

User: «убери пока из харнесса archmap, мы им не пользуемся он толко жрет токены».

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| R01 | archmap modules gone | Deleted: tools/archmap.mjs, archmap-analysis.mjs, archmap-problems.mjs, archmap-cache.mjs, archmap-report.mjs, archmap-demo.mjs, tools/report/**, tools/tests/archmap-{analysis,problems,report}.test.mjs, tools/package.json, tools/package-lock.json (typescript existed only for archmap), skills/architecture-observability/**, repo .archmap/. `node tools/archmap.mjs` → module not found | in-spec |
| R02 | Prompt law cleaned | `agent/AGENTS.md` ARCHITECTURE VISIBILITY section and `agent/agents/orchestrator.md` archmap block removed; no prompt surface mentions archmap; prompt-lint scan clean + baseline refreshed (both trees) | in-spec |
| R03 | auto-review survives without archmap | Sections: tsc (report-only) · eslint (report-only) · `npm test` (gate) · `node tools/debt-ledger.mjs scan --root <root> --check` (gate); exit 1 on any gate failure, 0 otherwise; Russian report; no archmap subprocess or .archmap reads; test file updated | in-spec |
| R04 | Wiring/CI updated | sync.ps1 manifest without the 12 archmap entries; verify.ps1 archmap checks removed, auto-review check re-pointed to the debt gate; audit.ps1 archmap check removed; install.ps1 without `npm ci --prefix tools` and archmap mentions; test-portability asserts archmap ABSENT and debt-ledger present; repo-gate.yml and templates/ci/workflow-gate.yml without npm ci / archmap scan / artifact upload | in-spec |
| R05 | Docs cleaned | README removes «Карта архитектуры», archmap entries in the tools list and CI description; CONTEXT.md refs removed if any; .gitignore drops `.archmap/` and `archmap-demo/` | in-spec |
| R06 | No regressions | node suites green (archmap suites gone, auto-review suite updated), python 8/8, verify/audit/portability green at new counts, sync clean including removal of deployed copies in the harness root, `~/.agents/skills/architecture-observability` removed | in-spec |

Non-goals: deleting openspec/changes history (mentions there are historical record); removing the `.archmap` entry from the ignore lists inside tools/debt-ledger.mjs and tools/domain-context.mjs (intentional guard for legacy output dirs of user projects); removing `codemap` (a different capability).

Assumptions (stated): archmap is not referenced by any other tool except auto-review (subprocess) — verified by grep; typescript dependency belongs only to archmap-analysis.mjs.
