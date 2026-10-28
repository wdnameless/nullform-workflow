# Reusable Quality Gates (S1)

Five standalone, zero-external-dependency quality gates designed to run against any repository tree via `--root <dir>`.

## Gate Matrix

| Gate | Command | Default Thresholds | Scope / Config File | Zero-Dep? |
|---|---|---|---|---|
| **code-size** | `nullform quality code-size check [--root <dir>]` | maxLines ≤ 700 / file, maxFunctionLines ≤ 120 / function | `.code-size.json` (scope), `.code-size.baseline.json` | Yes (Node stdlib) |
| **clone-coverage** | `node tools/clone-coverage.mjs check [--root <dir>]` | minLines: 10, failLines: 35 (Type-1/Type-2) | `.clone.json` (`{scope:[...]}`), `.clone-baseline.json` | Yes (Node stdlib) |
| **quality** | `nullform quality check [--root <dir>] [--stack <id>] [--changed]` | COCO ≤ 15 / function (ratchet on growth) | `tools/quality/stacks.json`, `.quality-baseline.json` | Yes (Node stdlib runner) |
| **coverage-changed** | `node tools/coverage-changed.mjs [--root <dir>] [--base <ref>] [--suites <dir>]` | changed lines coverage ≥ 50% | Git diff vs base ref (`--suites` default `tools/tests`) | Yes (`node:test`) |
| **mutation-changed** | `node tools/mutation-changed.mjs [--root <dir>] [--base <ref>] [--suites <dir>]` | mutation score ≥ 80%, mutants/file ≤ 10 | Git diff vs base ref (`--suites` default `tools/tests`) | Yes (Node stdlib mutator) |

## Ratchets & Escape Hatches

- **Ratchets**: Baseline files (`.*-baseline.json`) freeze legacy violations. CI fails only on *growth* beyond baseline or *new* unbaselined offenders.
- **Escape Hatches**:
  - `defer: <reason> | ceiling: <limit> | upgrade: <trigger>` in file header (first 50 lines) exempts file from code-size and clone gates.
  - `// code-size:allow` on function declaration line exempts the function.
  - `// clone:allow` on start line of clone exempts the specific block.

## Foreign-Project CI Snippet

Add this step to any GitHub Actions workflow to run gates against a target repository:

```yaml
- name: Run Quality Gates
  run: |
    # Install nullform CLI globally or run from vendored checkout
    npx nullform quality code-size check --root .
    node path/to/tools/clone-coverage.mjs check --root .
    npx nullform quality check --root . --changed
    node path/to/tools/coverage-changed.mjs --root . --base ${{ github.base_ref || 'main' }} --suites tests
    node path/to/tools/mutation-changed.mjs --root . --base ${{ github.base_ref || 'main' }} --suites tests
```
