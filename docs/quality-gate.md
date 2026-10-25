# Stack-aware quality gate

`tools/quality.mjs` — one command that installs the right static analyzer for the
project's stack and then holds cognitive complexity (COCO) at the level it already has,
so it cannot drift up.

Why the ratchet and not a threshold: measured on this repository, `sonarjs` reports
**687 functions, median 8, p90 33, max 315, and 186 above 15**. A plain `--max 15` gate
would be red on day one for 186 functions; nobody keeps a gate that starts red. The
ratchet turns that into one recorded baseline and one rule — *do not grow*.

## Commands

```bash
nullform quality detect                  # which stacks, and the file that proved each
nullform quality plan                    # what install would run, touching nothing
nullform quality install --dry-run       # same, without writing
nullform quality install                 # sidecar configs + baseline seed
nullform quality install --allow-host-install   # CI runners only: allow pip outside a venv
nullform quality check                   # the gate: exit 0/1/2
nullform quality check --changed         # only tracked+untracked files in the stack's languages
nullform quality baseline                # re-seed; may only LOWER a recorded value
```

`node tools/quality.mjs …` is the same code path; the npm entrypoint only forwards argv.

## Exit codes

| code | meaning |
|---|---|
| 0 | every detected stack ran and nothing grew |
| 1 | a violation, or an analyzer did not run (`unverified`) |
| 2 | cannot run: bad flags, unknown stack, no stack detected |

`install` refuses to run a `pip install` outside a project virtualenv and reports
`skipped-no-venv`; `--allow-host-install` exists for disposable CI runners, where installing
is not a change to a machine anyone keeps. It is never the default: an early version of this
tool put pylint into the system interpreter of the development host.

`unverified` is deliberately an error. A missing toolchain reported as `pass` is how a
gate becomes decoration.

## The ratchet

`.quality-baseline.json`:

```json
{
  "version": 1,
  "stacks": {
    "node": {
      "threshold": 15,
      "seeded": true,
      "functions": { "tools/sync.mjs:main": 315 }
    }
  }
}
```

- key is `repo/relative/file.mjs:functionName`, with `#2` appended for a second
  same-named function in one file (same convention as `tools/code-size.mjs`);
- a function at or below `threshold` is never recorded and never fails;
- above the threshold it fails as **new** when absent, and as **growth** when it exceeds
  its recorded value by any amount;
- `baseline` re-seeds with `min(recorded, measured)` — a refactor lowers the ceiling, and
  re-running the command can never quietly raise it back;
- a recorded entry whose function no longer appears is **carried forward**, because a
  rename is indistinguishable from a deletion. Dropping it silently let `rename +
  baseline` erase a ceiling: the renamed function read as "new" and was re-baselined at
  today's number. The re-seed reports how many entries it kept without a current match;
  `baseline --prune` is the explicit way to drop them;
- `seeded: false` is a setup gap and reports as `unverified`, not as N findings. Run
  `install` again once the toolchain is present.

Removing an entry by hand is the same as accepting a new offender on the next run: the
gate will report it as `new` again. Lowering a value by hand is allowed and honest.

## Escape hatch

Use the analyzer's own directive, with a reason:

```js
// eslint-disable-next-line sonarjs/cognitive-complexity -- flattening this state machine would hide the transitions
```

```python
# pylint: disable=too-cognitively-complex  # protocol dispatch table, one branch per message type
```

The gate does not invent a suppression syntax. It reports counts, so a reason-less
suppression is visible in review rather than silently swallowed — `eslint --suppress-all`
is explicitly **not** used: it suppresses per file+rule and lets growth through unchecked
(verified: 4→5 nested `if` still exits 0).

## Stack matrix

The matrix is `tools/quality/stacks.json` — data, not code. Adding a language is one row:
`markers` (glob list; the first match is quoted as evidence), `coco`
(`native` / `proxy` / `none`), `metric` (the honest name), `threshold`, `run.argv`
(tokens `{root} {quality} {python} {files...}`), `run.parser`, `install`, `configs`,
`verifiedOn`.

| stack | analyzer | coco | status |
|---|---|---|---|
| node | eslint-plugin-sonarjs | native | executed (eslint 9.39.5, sonarjs 4.2.2) |
| python | pylint-cognitive-complexity R7001 | native | executed (pylint 4.1.3, plugin 0.1.1) |
| rust | `clippy::cognitive_complexity` | native | executed (clippy 1.98.0) — allow-by-default lint, enabled with `-W` |
| csharp | SonarAnalyzer.CSharp S3776 | native | executed (10.35.0.4138, .NET SDK 8.0.416) — off by default, enabled via `.editorconfig` |
| go | gocognit via golangci-lint | native | adapter only, unproven here |
| java | PMD `CognitiveComplexity` | native | adapter only, unproven here |
| kotlin | detekt `CognitiveComplexMethod` | native | adapter only, unproven here |
| php | TomasVotruba/cognitive-complexity via PHPStan | native | adapter only, unproven here (PHPMD has no COCO rule) |
| ruby | RuboCop `Metrics/PerceivedComplexity` | **proxy** | Perceived ≠ COCO |
| swift | SwiftLint `cyclomatic_complexity` | **proxy** | cyclomatic ≠ COCO |

`detect` prints `UNPROVEN on this host` for adapters with `verifiedOn: null`. That is a
statement about this machine, not about the adapter's correctness.

## Why proxy stack are separated

Scores from different implementations are not comparable: detekt's 15, gocognit's 15 and
`sonarjs`'s 15 are computed by different algorithms over different syntax. Only the
**count of violations** can be read across stacks. Never average or sum COCO values
across tools.

## CI

`templates/ci/workflow-gate.yml` runs the gate only when `.quality-baseline.json` exists,
so a consumer project that has not opted in is not failed by a missing file:

```bash
node tools/quality.mjs check
```

For a monorepo, `check --changed` limits the run to languages the diff actually touched.

## File selection

The gate never hands an analyzer a bare directory. Each run receives an explicit list of
the project's own sources, built from the stack's `*.ext` markers minus one exclusion list
(`node_modules`, `.venv`, `venv`, `vendor`, `target`, `dist`, `build`, `obj`, `.tmp`,
`.quality`, caches). Two failures this prevents, both observed:

- pylint ran on a project root that contained a CI virtualenv and reported **556 findings**
  from `site-packages` — the analyzer grading itself;
- `bin/` was once in the exclusion list (copied from the code-size gate, where it means
  build output) and coverage silently dropped seven baselined functions, turning the gate
  green by measuring less.

A `.cjs`/`.mjs`-only marker set matters for the same reason: a file type missing from
`markers` is a file type the gate does not see.

## Boundaries

- Does not fix code. It reports; a human or an agent decides.
- Does not rewrite the project's own `eslint.config.mjs`, `pyproject.toml`, `clippy.toml`,
  `.rubocop.yml`: all harness-owned files live under `.quality/<stack>/` and are passed
  explicitly (`-c`, `--rcfile`, `CLIPPY_CONF_DIR`), so the two configs compose.
- Does not install anything for a stack that was not detected.
- Does not run its own analyzer install for `node`/`python` — `install` writes configs and
  reports `skipped-missing-toolchain` if the analyzer is absent; adding a devDependency is
  a project decision, recorded here as an explicit follow-up.
- Does not measure cyclomatic complexity, coupling, or line length — `tools/code-size.mjs`
  covers size, and neither metric substitutes for the other.
