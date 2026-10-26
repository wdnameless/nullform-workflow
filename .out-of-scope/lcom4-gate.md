# LCOM4 as a quality gate

Rejected: 2026-10-25

## What was proposed

Add LCOM4 (lack of cohesion of methods, Hitz & Montazeri 1996) to the quality gate:
build a graph per module — nodes are methods and attributes, an edge is "method
reads attribute" or "method calls method" — and fail the build when the number of
connected components exceeds 1, on the theory that each extra component is a
sub-module waiting to be extracted. Source: SQM 7/24 on cohesion (Yegor Bugayenko),
which also supplies the six-level binding vocabulary and the "form follows function"
rule that *were* adopted.

## Why it was rejected

The score is not stable under the definition of an edge, and any threshold turns that
instability into a build failure.

Measured on this repo (111 non-test modules under `tools/ bin/ core/ agent/`, espree
AST, throwaway probe):

| edge definition | median components | modules at exactly 1 | top offender |
|---|---|---|---|
| call / shared module-level state | 2 | 49 of 104 | `tools/doctor-checks.mjs` = 14 |
| + shared parameter name (`ctx`) | 4 | 8 of 104 | `tools/doctor-checks.mjs` = 10, `tools/workflow.mjs` = 12 |

Adding one line to the edge rule moves the median from 2 to 4 and the count of "clean"
modules from 49 to 8. Both definitions are defensible; neither is the metric's own.

Two further mismatches with this codebase:

- **Almost nothing to measure.** The repo has 3 classes (`DeploymentJournal`,
  `NotConfiguredError`, `JevRuntime`) against 114 non-test source modules. LCOM4 is
  defined over class members; applying it to ESM modules is already an adaptation, and
  the adaptation is where the arbitrariness enters.
- **The top offenders are registries by design.** `doctor-checks.mjs` is 16 independent
  checks dispatched from one table; `workflow.mjs` is a CLI dispatcher. Their components
  do not call each other *because* independence is the contract — separating them would
  not reduce complexity, it would only move the dispatch table. The metric scores a
  deliberate design as a defect.
- **The lecture itself disclaims it.** The author calls the metric outdated, notes the
  semantics of the symptom do not match the semantics of the code, and closes by saying
  a metric becomes trustworthy only after its verdicts are compared with human
  judgement on a large corpus. That comparison has not been run here.

## Evidence

Probe (throwaway, not committed): walk `tools/ bin/ core/ agent/`, skip `node_modules`,
`tests`, `temp`, and `*.test.*`; parse each file with `espree` (`sourceType: "module"`);
take every top-level `function`/`const`-arrow/`class` declaration as a node; add an edge
when one calls another, or when both touch the same module-level mutable binding
(`let`/`var` at top level); count connected components with union-find. The variant adds
a third edge rule: both declare a parameter with the same name. 111 modules parsed, 3
`.ts` skipped by the parser (97 of 114 non-test sources are reachable this way, the rest
being tests).

Existing gates already cover what LCOM4 would nominally catch, at the granularity this
repo actually has: `tools/quality.mjs` (cognitive complexity per function),
`tools/code-size.mjs` (lines per file and per function), `tools/prompt-lint.mjs sizes`
(prompt surfaces). None of them measures module shape, and that gap is filled by the
`split:`/`merge:` review tags plus the six-level vocabulary in
`skill://codebase-design` §4 — a human judgement, deliberately, not a number.

## What would reopen it

Any one of these, verified:

1. A human-agreement study as the author describes: ≥100 sampled modules scored blind
   by ≥3 engineers ("is this one cohesive unit?"), compared with the metric; agreement
   materially above 50% under **one** published edge definition, with that definition
   written into the tool.
2. The repo grows a class-heavy core where LCOM4's original semantics apply directly —
   e.g. a TypeScript domain layer where "method reads attribute" is a real relation, not
   a mapping over module-level bindings.
3. Someone shows a defect class that the three existing gates plus review genuinely
   missed, and that LCOM4 flags at the moment the defect was introduced. A metric earns
   a gate by catching a bug, not by explaining one after the fact.
