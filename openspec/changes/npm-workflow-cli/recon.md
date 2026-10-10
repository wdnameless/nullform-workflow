# Recon: npm-workflow-cli

Files touched: package/bin new; tools/install-harness.mjs, doctor.mjs, self-update.mjs, related tests, README.md, CONTEXT.md, VERSION.

- No root package.json currently exists. Existing installHarness exports eight concrete harness choices and auto/all; it is the shared installer, not a new framework target.
- Existing JSON readers catch parse errors and reset to empty objects; writeAdapter replaces whole instruction files; these are unsafe for the accepted preservation requirement.
- Existing doctor defaults to ~/.omp and requires OMP plugin manifests irrespective of another selected host.
- Current self-update fetches GitHub tags, requires Git and invokes OMP-root reinstall; npm cutover needs to replace that flow and migrate doctor/tests/docs callers.
- OMP/OpenCode source-installer dry-run was exercised successfully in the prior feasibility step.
- npm whoami: ENEEDAUTH. Registry queries for both proposed names returned E404. User chose nullform-workflow and verified package delivery without public publishing.
- Read canonical CONTEXT.md and tools/CODEMAP.md. Codemap is stale and contains generated bench/runs snapshots; those are out of implementation scope and must not enter npm files.
- Language server reports unavailable; exhaustive known-symbol grep enumerated installHarness/checkRelease/executeUpdate callers.
- Existing user changes: eval-metrics manifest and a product video transcript, not in this change.

Acceptance check: actual npm pack/install --global --ignore-scripts, CLI menu/headless/init/doctor, all-eight isolated adapter homes and saved custom roots, user-data preservation, real loopback-registry newer-version upgrade; existing full tests plus native reviewer/Stage-B/oracle receipts. Missing host programs/credentials are honest SETUP, not mocked readiness. Public npm publishing is excluded by explicit user selection.
