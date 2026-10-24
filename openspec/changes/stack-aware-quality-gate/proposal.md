# Stack-aware quality gate

## Why

Cognitive complexity (COCO) is measurable and deterministic, and the tools that compute it
already exist for every language this harness supports. We had none of them wired in: the
repo ran ESLint with `complexity: 200`, which is cyclomatic and effectively off. Measured on
this tree, `sonarjs` reports **687 functions, median 8, p90 33, max 315 and 186 above 15** —
a plain threshold gate would be red on 186 functions on day one, which is how quality gates
get deleted.

Two problems, one mechanism: choose the analyzer from the project's stack, and hold COCO at
or below what it already is instead of demanding an instant rewrite.

## What changes

`tools/quality.mjs` with `tools/quality/stacks.json` as a data-only matrix of ten stacks
(node, python, rust, go, java, kotlin, csharp, php, ruby, swift). Commands: `detect`, `plan`,
`install`, `check`, `baseline`; entrypoints `node tools/quality.mjs …` and
`nullform quality …` are the same code path.

- **Selection by evidence**: markers prove the stack, and the proving file is printed.
- **Ratchet**: `.quality-baseline.json` records today's offenders per `file:function`; `check`
  fails only on a new offender above the threshold or growth past a recorded value;
  `baseline` re-seeds with `min(recorded, measured)`, so a refactor lowers the ceiling and no
  command can quietly raise it.
- **Honest degradation**: a missing/crashed/unparsable analyzer exits 1 as `unverified`.
  `eslint --suppress-all` is deliberately not used — verified that it lets 4→5 nested `if`
  pass, because it suppresses per file+rule rather than per value.
- **Sidecar configs**: everything harness-owned lives in `.quality/<stack>/` and is passed
  explicitly (`-c`, `--rcfile`, `CLIPPY_CONF_DIR`), so a project's own config stays untouched
  and the two compose.
- **Proxy discipline**: Ruby (RuboCop PerceivedComplexity) and Swift (SwiftLint cyclomatic)
  are labelled `proxy` with a metric string that says they are not COCO.

## Validation

- 14 contract tests (`tools/tests/quality.test.mjs`): detection evidence, ratchet
  new/growth/below-threshold, baseline floor, argv templating without a shell, all nine
  parsers, unverified≠pass, dry-run writes nothing, unseeded≠45 findings.
- Live runs: node (eslint 9.39.5 + sonarjs 4.2.2) and python (pylint 4.1.3 +
  pylint-cognitive-complexity 0.1.1) each pass on this tree after seeding (242 + 45 entries).
- Negative proof: inserting three nested `if` into `tools/plan-check.mjs` turned `check` from
  exit 0 into exit 1 with `117 > baseline 106`; reverting restored exit 0.
- Baseline floor proof: a baseline artificially raised to 200 was re-seeded down to the
  measured 106 and reported as `1 lowered`.
- The gate caught this change's own growth twice (`runQualityCli` 110→113,
  `parseCliArgs` 26→28, `main` 20→21). Each was refactored rather than re-seeded.
- Adapters for go/java/kotlin/php are implemented against each tool's documented report shape
  and are **unproven on this host** (no toolchain installed); `detect` prints
  `UNPROVEN on this host` for them. `verifiedOn` records what was actually executed.

## Scope

No analyzer auto-fixes, no cross-stack score aggregation (implementations are not
comparable), no rewrite of `tools/code-size.mjs` or its baseline, no new runtime dependency
for the harness (`tools/quality.mjs` is stdlib plus two existing local modules). Installing an
analyzer into a consumer project is one `install` call; the harness itself only gains a
devDependency (`eslint-plugin-sonarjs@4.2.2`).
