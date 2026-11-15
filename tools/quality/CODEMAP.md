# tools/quality/

## Responsibility
Multi-stack static-analysis execution engine and cognitive-complexity (COCO) ratchet. Provides declarative language-stack detection, harness-owned sidecar configuration generation, analyzer execution with bounded command-line batching, report normalization into a uniform complexity row schema, and monotonic baseline enforcement preventing cognitive complexity drift.

## Design Patterns
- **Data-Driven Stack Matrix (Schema Contract)**: `stacks.json` defines the declarative registry of supported language stacks (`loadStacks`, `STACKS_FILE`), declaring stack identification `markers`, metric classification `coco` (`native` | `proxy` | `none`), honest metric label `metric`, default `threshold`, invocation templates `run`, toolchain-preserving installer commands `install`, sidecar artifact mappings `configs`, and runtime environment overrides `env`.
- **Evidence-Based Detection & Bounded Discovery**: `detectStacks` identifies applicable project stacks by executing a depth-bounded filesystem walk (`walk`, `SKIP_DIRS`) and asserting the first matching pattern in `markers` as cryptographic evidence (`proof`), ensuring declared project manifests outrank incidental extension matches without traversing symlinks or build caches.
- **Template Argument Expansion & Length-Bounded Batching**: `expandArgv` substitutes `{root}`, `{quality}`, and interpreter binaries (`pythonBin`, `venvPython`), expanding `{files...}` from declared extensions via `sourceFiles`. `batchArgv` slices long file lists into chunks respecting a command-line length threshold (`limit = 6000`), while `toolAvailable` verifies binary presence across platform-specific executable probes.
- **Process Isolation & Tool Runner Execution**: `runStack` coordinates sidecar provisioning (`writeConfigs`, `sidecarPresent`, `CONFIG_BODIES`) and child process invocation (`spawnArgv`), executing native analyzers and batching commands while routing raw outputs to dedicated report translators.
- **Report Normalization (Parser Adapters)**: `parsers.mjs` maps disparate analyzer outputs to a uniform row schema `{ file, line, column, coco, threshold }` across nine tools in `PARSERS`: `parseEslintJson`, `parsePylintJson`, `parseCargoJson`, `parseSarif`, `parseDotnetText`, `parseGolangciJson`, `parsePhpstanJson`, `parseRubocopJson`, and `parseSwiftlintJson`, with `fromRatio` parsing ratio formats and `nameRows` resolving AST function identifiers.
- **Monotonic Ratchet (Strict Non-Increasing Baseline)**: `applyRatchet`, `loadBaseline`, `saveBaseline`, `baselineKey`, `disambiguate`, and `mergeBaselineEntries` enforce that baselined cognitive complexity values (`BASELINE_FILE`, `.quality-baseline.json`) can only decrease or hold steady (`Math.min(prev, row.coco)`), failing on unbaselined offenders above threshold or regressions over existing levels while permitting pruning of removed symbols.
- **Sidecar Artifact Generation**: `writeConfigs` materializes harness-owned configuration files inside `.quality` (`SIDECAR_DIR`) via `CONFIG_BODIES` templates without modifying the host project's configuration files, while `installAnalyzer` safely provisions tools inside local environments (`venvPython`).

## Data & Control Flow
1. **Detection & Stack Loading**: Callers load stack definitions via `loadStacks` and evaluate candidate project trees with `detectStacks`, proving membership through matched file proofs.
2. **Configuration & Installation**: `writeConfigs` writes analyzer configuration files into `SIDECAR_DIR` (`.quality`), while `installAnalyzer` executes stack-specific installation commands, refusing global interpreter mutations unless explicitly permitted.
3. **Target Scope Resolution**: `changedFiles` extracts git diff targets relative to HEAD when scoped, or `sourceFiles` identifies matching files by extension markers across the bounded directory walk (`walk`).
4. **Execution & Batching**: `runStack` expands command-line arguments (`expandArgv`), verifies tool availability (`toolAvailable`), batches files within size boundaries (`batchArgv`), and executes commands via `spawnArgv`.
5. **Output Normalization**: Analyzer stdout/stderr is processed by the configured translator in `PARSERS` (`parsers.mjs`), returning normalized rows decorated with function names (`nameRows`) and disambiguated keys (`baselineKey`, `disambiguate`).
6. **Ratchet Evaluation & Baseline Settlement**: `applyRatchet` checks rows against the loaded baseline (`loadBaseline`), emitting failures for new or grown violations. For baseline updates, `mergeBaselineEntries` updates recorded scores strictly monotonically and `saveBaseline` commits `.quality-baseline.json`.

## Integration Points
- **Imports**: `../installation/state.mjs` (`resolveNpmRunner` for safe npm execution on Windows).
- **Facade & CLI Consumers**: Delegated to by `tools/quality.mjs` (`detect`, `plan`, `install`, `check`, `baseline` CLI commands; re-exports all engine exports) and `bin/nullform.mjs` (`runQualityCommand`).
- **External Dependencies & Runners**: Spawns platform package managers and analyzers (`eslint`, `pylint`, `cargo`, `golangci-lint`, `dotnet`, `pmd`, `detekt`, `phpstan`, `rubocop`, `swiftlint`, `git`, `cmd.exe` on Windows).
- **Filesystem Contracts**:
  - `stacks.json` (declarative analyzer matrix and schemas).
  - `.quality-baseline.json` (`BASELINE_FILE`: committed per-stack monotonic complexity ratchets).
  - `.quality/` (`SIDECAR_DIR`: generated harness-owned configuration sidecars).
