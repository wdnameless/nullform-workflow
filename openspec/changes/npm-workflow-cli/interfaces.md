# Interfaces: npm-workflow-cli

## Owners

- PackageCli: package.json, VERSION, LICENSE if needed, bin/nullform.mjs, tools/self-update.mjs, tools/tests/self-update.test.mjs, tools/tests/nullform-cli.test.mjs. No installer/doctor/docs edits.
- HarnessAdapters: tools/install-harness.mjs, tools/doctor.mjs, required focused install-config helper if extraction earns its place, existing install/doctor tests and affected contract-only tests. No package/CLI/update/docs edits.
- PackageProof: tools/npm-smoke.mjs, tools/tests/npm-distribution.test.mjs, local registry helper under tools/tests if required, README.md, CONTEXT.md. No other code ownership. Tests/build/lint run only by parent after integration.

## Shared contracts

- Package: name nullform-workflow, version 1.1.0, type module, bin nullform -> bin/nullform.mjs. stdlib-first; no lifecycle script modifies home. Explicit files allowlist; preserve bundled third-party licenses; no .env/live credentials, bench/runs, .tmp, .workflow, history, node_modules or source test tree in tarball.
- CLI: init, doctor, update, --help/-h and --version. init supports --harness <one of 8>, --root, --user-home, --yes, --dry-run, --json. Interactive menu uses node readline; non-TTY requires explicit or saved selection and --yes for writes. Dry-run never writes state or target.
- Installer: retain installHarness(options) export; options.harness/root/userHome/dryRun are authoritative. CLI passes all four and prior managedFiles if used. Return plan.harness/root/userHome/filesToCopy/adapters; return plan.managedFiles mapping absolute integration file paths to hashes if required for safe ownership. Installer must accept all eight choices and preflight configs before any user-data overwrite. Keep legacy source installs; no npm-specific alternate installer.
- State: <userHome>/.nullform/installation.json, schemaVersion:1, harness:string, root:absolute, userHome:absolute, version:semver, optional managedFiles map. PackageCli is sole state writer; save only after successful installation. No keys/config contents stored in state. Existing state validation fails closed.
- Doctor: retain synchronous runDoctor(options); add options.targetHarness (8 choices), default omp for existing callers. CLI invokes installed root, selected targetHarness, explicit userHome-derived native dirs. Return existing {ok,checks,summary,...}; missing host binary/configured provider is explicit setup/warn, not pass. A malformed native config/missing managed integration is fail. OMP plugin/config/extension checks only apply to omp; do not merely hide failures in a global skip flag.
- Update: tools/self-update.mjs retains checkRelease(options) shape {status:clean|drift|setup,ok,current,latest,detail,...}; reads npm package metadata (version), never GitHub tag_name or Git. options.apiUrl may override metadata endpoint for doctor/local smoke; --registry/native npm config honored. CLI update uses real npm install --global into the effective current prefix and launches the NEW installed bin for re-init/check of saved harness/root/home (not stale loaded modules). Shell-free Node/npm invocation or verified safe Windows argv handling; no untrusted interpolation. Nonzero npm/install/doctor exit => error, never false success. Installed tarball source is not assumed to have .git.
- npm-smoke: node tools/npm-smoke.mjs is the deterministic product command for native review/oracle. Real npm pack, temp prefix/cache/home and loopback registry on port0. No caller's home/global install/network credentials modified. Emit requirement-level evidence and exit nonzero on failed assertions. Verify install with --ignore-scripts, all eight choices, preservation/idempotence/custom roots, and actual newer package version after update.

## Integration risk

PackageCli and HarnessAdapters share interfaces above, not files. PackageProof may author against contracts before implementations return. Builders must read existing patterns and external native-format sources first; send any contract correction via parent, not silently change a sibling API. Skip all test/build/lint/formatter executions mid-flight; parent executes after integration.
