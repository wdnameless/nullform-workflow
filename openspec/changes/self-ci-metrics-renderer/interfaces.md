# Interfaces and ownership — self-ci-metrics-renderer

## Renderer split (worker: RendererSplit)
- `tools/archmap-report.mjs` KEEPS `export function renderHtml(state, delta, findings): string` — byte-compatible behavior.
- New: `tools/report/client.js` — the ENTIRE client script as a real JS file. Server injects data/constants by replacing the literal marker line `/*__ARCHMAP_DATA__*/` at top with `const DATA = ...; const KIND_RU = ...;` etc. (JSON.stringify each map). No `${}` interpolation inside client.js — it is verbatim JS, escaping bug class eliminated.
- New: `tools/report/page.css` — entire stylesheet, injected verbatim into `<style>`.
- Renderer reads both files once (module-level lazy cache) via `readFileSync(new URL("./report/client.js", import.meta.url))` — works from any cwd; missing file = throw with clear Russian error.
- Server-side helpers (layout, embedData, findings HTML) stay in archmap-report.mjs.
- tools/tests/archmap-report.test.mjs must still pass unchanged assertions; add test: generated client script passes `new vm.Script()` (the exact failure class we hit twice).
- sync.ps1 manifest gets `tools\report\client.js` and `tools\report\page.css` (Main adds; worker lists them in FILES).

## Metrics (worker: CiMetrics)
- workflow.mjs: on `close` (incl. --force) append JSON line to `.workflow/metrics.jsonl`: `{task, tier, startedAt, closedAt, durationMs, forced, auto|null, artifactsCount}`. `.workflow/` already gitignored — verify.
- New command `metrics [--root .]`: prints `tasks: N · by tier {T0:a,T1:b,...} · avg duration · forced: k` and exits 0. No breaking change to start/check/status/close outputs (verify.ps1 greps them).
- node:test regression: close appends one line with all fields; metrics aggregates correctly; forced close counted.
- `.github/workflows/repo-gate.yml` (this repo's real CI, adapted from templates/ci/workflow-gate.yml): node 20, `npm ci --prefix tools --ignore-scripts`, `node --test tools/tests/`, openspec validate for changes present, archmap scan + artifact, auto-review exit gate.

## Ownership
- RendererSplit: tools/archmap-report.mjs, tools/report/**, tools/tests/archmap-report.test.mjs
- CiMetrics: tools/workflow.mjs, tools/tests/workflow-metrics.test.mjs, .github/workflows/repo-gate.yml, .gitignore (verify .workflow entry)
- Main: specs, sync.ps1 manifest, integration, git
Disjoint. Skip test runs while sibling works; parent validates.
