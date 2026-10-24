# Interfaces — stack-aware quality gate

## Ownership zones

| Path | Owner | Rule |
|---|---|---|
| `tools/quality.mjs` | this change | CLI + engine; stdlib only, no new harness dependency |
| `tools/quality/parsers.mjs` | this change | analyzer output → one row shape; never computes complexity |
| `tools/quality/stacks.json` | this change | the entire stack matrix; data-only |
| `tools/tests/quality.test.mjs` | this change | contract tests |
| `docs/quality-gate.md` | this change | operator documentation |
| `.quality/<stack>/*` | **generated at runtime** | project-local, harness-owned, gitignored by the project or committed by choice |
| `.quality-baseline.json` | **project** | committed by the consuming project; the ratchet state |
| `bin/nullform.mjs` | shared | added `quality` passthrough + `COMMANDS` table; no other behavior touched |
| `eslint.config.mjs` | **not touched** | the sidecar composes with it via `-c`, never replaces it |
| `tools/code-size.mjs` | **not touched** | its `globToRegex` is imported, not copied |
| `tools/workflow.mjs` | **not touched** | lane protocol independent of this gate |

## Public signatures

```js
// tools/quality.mjs
export const STACKS_FILE: string          // absolute path to stacks.json
export const BASELINE_FILE = ".quality-baseline.json"
export const SIDECAR_DIR = ".quality"

export function loadStacks(file?): { schemaVersion, defaults, stacks: Stack[] }
export function detectStacks(root, doc?): Detected[]
export function expandArgv(argv, { root, qualityDir, files, stack }): string[]
export function toolAvailable(argv, cwd?): boolean
export function runStack(stack, { root, qualityDir, files }): RunResult
export function loadBaseline(root, file?): Baseline
export function saveBaseline(root, baseline, file?): void
export function baselineKey(row, relFile): string
export function applyRatchet(rows, stackBaseline, threshold): { failures, kept }
export function changedFiles(root, stack): string[] | null
export function writeConfigs(root, stack, doc): { file, status }[]
export function parseArgs(argv): Args
export function runQualityCli(argv?, io?): number   // 0 | 1 | 2

// tools/quality/parsers.mjs
export const PARSERS: Record<string, (stdout: string) => Row[]>
export function fromRatio(text): { coco, threshold } | null
export function parseEslintJson / parsePylintJson / parseCargoJson / parseDotnetText
export function parseGolangciJson / parsePhpstanJson / parseRubocopJson
export function parseSwiftlintJson / parseSarif

// bin/nullform.mjs (added)
export async function runQualityCommand(qualityArgs, deps?): Promise<number>
```

## Data contracts

```ts
Row       = { file: string; line: number; column?: number; fn?: string|null; coco: number; threshold?: number|null }
RunResult = { rows: Row[]; status: "ran"|"missing-tool"|"tool-error"|"unparsable"|"no-runner"|"no-input"; detail?: string; argv?: string[] }
Detected  = { id, display, coco: "native"|"proxy"|"none", metric, proof: string, verifiedOn: string|null }
Baseline  = { version: 1; stacks: Record<stackId, { threshold: number; seeded: boolean; functions: Record<key, number>; reason?: string; detail?: string|null }> }
Failure   = { type: "new"|"growth"; key; file; line; coco; base?; threshold; message }
Stack     = { id; display; markers: string[]; coco; metric; threshold; run?: { argv: string[]; parser: string };
              install?: { argv: string[]; whenPresent?: { marker: string; argv: string[] } } | null;
              configs?: Record<string, ConfigKind>; env?: Record<string, string>; verifiedOn: string|null }
```

## Invariants another agent must not break

1. `runStack` never returns `status: "ran"` with an empty report when the analyzer printed
   nothing — that would read as "clean".
2. `parseArgs`/`runQualityCli` never throw for bad input; they return 2.
3. `baseline` never raises a stored value. `Math.min` is the whole contract.
4. `stacks.json` stays the only place a language is named; `tools/quality.mjs` must not gain
   an `if (stack === "python")` branch.
5. A `coco: "proxy"` stack keeps a metric string that says it is not COCO.
6. Exit code 0 from `check` means *every* detected stack ran. `unverified` is 1.

## Wiring touched outside this change

- `package.json` — devDependency `eslint-plugin-sonarjs@4.2.2`, scripts `quality` / `quality:baseline`, `files` includes `tools/quality/**`.
- `tools/sync-manifest.json` — 3 entries so an installed harness receives the gate.
- `.github/workflows/repo-gate.yml` — one step, gated on `.quality-baseline.json`.
- `templates/ci/workflow-gate.yml` — same step for consumer projects.
- `docs/dependency-policy.md` — pin count 6 → 7.
- `bin/nullform.mjs` — `quality` in `PASSTHROUGH`, `COMMANDS`, help; the pre-existing
  if-chain became a table (behavior identical, verified by running `doctor`/`--help`).
