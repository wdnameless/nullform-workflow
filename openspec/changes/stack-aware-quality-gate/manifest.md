# Requirements — stack-aware quality gate (T2)

User (2026-10-24, after video `oRUux3w4rsc`):

> «давай подумаем о универсальном методе чтобы в нашем воркфлоу устанавливался статический анализатор
> в зависимости от выбора стека для проекта, хочу сделать это как то умно»
>
> «Так же нужно держать COCO (congitive complexity) на нужном уровне, там диктор говорит про это»

Decisions taken in the `ask` widget (same session, verbatim option labels):

> scope: «Сразу все 9 стеков из матрицы»
> policy: «Ratchet: порог 15 для новых/выросших, baseline на легаси»
> surface: «`nullform quality install|check` — отдельная команда»

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| R01 | Universal method: analyzer chosen by the project's stack | `tools/quality/stacks.json` is the only place a stack is described (marker globs, install, check argv, parser, default threshold); `node tools/quality.mjs detect` prints every detected stack with the marker file that proved it; adding a stack is a data row, not code | in-spec |
| R02 | Analyzer install per detected stack | `install` writes the analyzer config owned by the harness (sidecar, never the project's own config) and installs the pinned analyzer package; idempotent (second run reports `already`), `--dry-run` prints the plan and touches nothing | in-spec |
| R03 | All stacks from the lecture matrix | Adapters for node, python, rust, go, java, kotlin, csharp, php, ruby, swift. Each row declares `coco: native\|proxy\|none` and the metric it actually measures; `proxy` never reports itself as COCO | in-spec |
| R04 | COCO held at the required level | `check` fails on a function above threshold that is absent from the baseline, and on any function that grew past its baselined value; unchanged legacy passes; `baseline --update` may only lower values, never raise them | in-spec |
| R05 | Separate command surface | `nullform quality <detect\|plan\|install\|check\|baseline>` and `node tools/quality.mjs …` behave identically; `check` exit 0 clean / 1 violation / 2 cannot run | in-spec |
| R06 | Honest degradation | Missing toolchain or missing parser support reports `unverified` (never `pass`); `detect` says which adapters are unproven in this environment; no analyzer is invented or silently substituted | in-spec |
| R07 | Evidence in the existing gates | CI template runs the gate only when the baseline exists; `docs/quality-gate.md` documents the thresholds, the ratchet and the escape (native disable directive with a mandatory reason); `docs/dependency-policy.md` gains the new pin | in-spec |

## Derived obligations (not new user quotes)

- D1: our own tree must pass day one → `install` seeds the baseline from the current tree (186 functions above 15).
- D2: no new runtime dependency for the harness: `tools/quality.mjs` is stdlib-only; analyzers are project devDeps, not harness deps.
- D3: never execute `npm install` / `pip install` for a *different* stack than the one detected.

## Non-goals

- Enforcing COCO on the whole tree immediately (that is 186 refactors; the chosen policy is ratchet).
- Comparing raw COCO numbers across tools (algorithms differ; only violation counts are comparable).
- Rewriting `tools/code-size.mjs` or merging the two baselines into one file.
- Auto-fixing code violations.

## Assumptions stated up front

- `PerceivedComplexity` (RuboCop) and `CyclomaticComplexity` (SwiftLint) are proxies, labeled `proxy`, and never fed into a cross-stack "score".
- Java PMD, Kotlin detekt and PHP/Ruby/Go/Swift adapters are implemented against each tool's documented SARIF/JSON shape but cannot be executed on this host (no `go`, `ruby`, `php`, no PMD, no detekt, no `swiftlint`). They ship as `verifiedOn: null` and are reported as unproven by `detect`.
- Executed on this host: node (sonarjs 4.2.2), python (pylint-cognitive-complexity 0.1.1), rust (clippy 1.98), csharp (SonarAnalyzer.CSharp 10.35 S3776).
