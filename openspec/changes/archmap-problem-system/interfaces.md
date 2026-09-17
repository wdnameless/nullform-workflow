# Interfaces and ownership — archmap problem system (T3)

## Problem schema (producer: tools/archmap-problems.mjs; consumer: renderer + json)
`state.problems: Array<Problem>` where
```ts
Problem = {
  id: string;              // stable: category:kind:file:line-hash
  severity: "critical"|"high"|"medium"|"low";
  category: "structure"|"optimization"|"security"|"reliability"|"maintainability";
  kind: string;            // machine kind: cycle, giant-file, eval, hardcoded-secret, swallowed-error, ...
  title: string;           // Russian, one line
  why: string;             // Russian, why it matters
  fix: string;             // Russian, suggested fix
  where: Array<{file:string; line?:number}>;
  prompt: string;          // ready Russian AI prompt: title + why + fix + file:lines + code excerpt (<=30 lines)
  heuristic: true;         // honesty marker, always true for static rules
}
```
Existing `findings(state)` stays for backwards compat (delta/verify); `problems` is the new user-facing list. json command exposes problems. Code excerpt read from source at scan time, bounded, never includes secrets (redact strings matching secret patterns with [REDACTED]).

## Severity rules (deterministic)
critical: hardcoded secret pattern; cycle with >4 files. high: dependency cycle; god-module; eval/new Function. medium: giant file, complexity>=60, innerHTML assignment, swallowed catch. low: orphan, wrapper, low MI, TODO-density. Sort: critical→high→medium→low; within level by rawWeight.

## Incremental cache (tools/archmap-cache.mjs)
`.archmap/cache.json`: {fileHash -> {members, symbols?, imports}}. On scan, unchanged hash skips re-analysis; JS/TS semantic analysis still runs per program but cached symbol payloads reused when file set unchanged. Never stale: hash covers content, cache versioned, deleted on schema bump. json reports cacheHitRate.

## Renderer contract (tools/archmap-report.mjs)
`renderHtml(state, delta, findings)` unchanged signature; reads state.problems when present. Views via buttons: Модули | Вызовы | Проблемы; cluster mode in Модули (folders as collapsible groups, expand-all button); per-file view = local graph (imports, importers, file's symbols+calls) with «← К карте» button; проблемы view = grouped by severity, category chips, copy button per problem using navigator.clipboard with execCommand fallback for file://. All Russian UI. Old states without problems render legacy findings.

## workflow.mjs extensions (worker: WorkflowHardening)
- `suggest --files a,b,c` -> {tier, confidence, reasons[]} heuristic (file count, new deps, schema/API keywords, blast radius).
- Budget config: reads `.workflow/budgets.json` {T0:10,T1:25,T2:45}; start prints per-tier budget; no hardcoded gateway quota.
- `start --auto --allow "src/**" --max-diff 5` guarded T0: only with explicit flags, records auto:true; refuses T1+.
Existing commands unchanged.

## CI/CD (worker: CiCd)
`.github/workflows/workflow-gate.yml` template in `templates/ci/`: openspec validate (if change), node tests, archmap scan + diff artifact, workflow.mjs check. README section. No secrets required.

## auto-review (worker: CiCd)
`node tools/auto-review.mjs --root .` -> Russian report: cycles (fail), tests presence, tsc/eslint if configs exist (report only), problems count by severity. Exit 1 on critical/high. Never edits code.

## Ownership (disjoint)
- ProblemEngine: tools/archmap.mjs, tools/archmap-problems.mjs, tools/archmap-cache.mjs, tools/tests/archmap-problems.test.mjs, tools/archmap-demo.mjs
- RendererV2: tools/archmap-report.mjs only
- WorkflowHardening: tools/workflow.mjs, agent/config.yml.example, README.md (budget section only), tools/tests/workflow-suggest.test.mjs
- CiCd: templates/ci/**, tools/auto-review.mjs, verify.ps1, tools/tests/auto-review.test.mjs, README.md (CI section only — coordinate with WorkflowHardening via Main, separate sections)
- Main: specs, interfaces, sync.ps1 manifest update, integration, git. README merge conflicts resolved by Main (distinct sections).
