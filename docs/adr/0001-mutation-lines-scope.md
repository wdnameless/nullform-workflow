# 0001. Mutation lines scope

## Status
Accepted

## Context
Running mutation testing on the first-N mutants gave arbitrary verdicts (e.g. 0% on workflow.mjs), because mutant generation order evaluated code unrelated to the actual PR diff.

## Decision
Scope mutation testing to changed lines using `--lines` (Stryker `--since` style), restricting mutant evaluation exclusively to lines modified relative to the base branch.

## Consequences
- CI mutation gate depends on changed-line scoping to provide honest feedback.
- Reverting loses gate honesty and reintroduces arbitrary verdicts on large files.
