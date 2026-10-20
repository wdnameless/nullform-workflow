# M1 internal module cutover contract

Apply only after SafetyOwner, SetupOwner and PolicyOwner semantic work is integrated. One owner for this full cutover; do not run overlapping movers. Base is the then-current integration commit, not29f7185.

## Preserve executable entrypoints

Keep actual commands in bin/nullform.mjs and tools/workflow.mjs, doctor.mjs, install-harness.mjs, verify.mjs, auto-review.mjs, sync.mjs and any other existing directly-executable maintenance tool. Do not turn them into compatibility shims or shallow re-export files: they continue owning CLI parsing/dispatch/reporting; cohesive command internals may move when necessary. Documented nullform commands remain stable. Internal module imports are a clean cutover, not a permanent dual path.

## Internal groups

- tools/review/: review-evidence, review-native-tools, review-budget, review-http-runtime, review-http-child, review-http-evidence implementations. Prefer concise filenames evidence.mjs, native-tools.mjs, budget.mjs, http-runtime.mjs, http-child.mjs, http-evidence.mjs (no redundant review/review prefix).
- tools/installation/: installation-state, harness-profiles, harness-adapters, harness-config, harness-capabilities, hermes-policy, deployment-journal, deployment-restore and non-executable self-update internals. Names state/profiles/adapters/config/capabilities/hermes-policy/journal/restore/update.mjs. Keep any true update CLI command stable if discovered.
- tools/workflow/: task-claim and workflow-workspaces internals as claims.mjs/workspaces.mjs.
- tools/worktree-snapshot.mjs remains the shared deep confinement/snapshot module. No generic shared/utils/registry/factory layer.

If bin/nullform.mjs grows past its baseline, move only a cohesive setup command or lifecycle responsibility into installation internals and migrate tests to the real implementation. Do not preserve unused bin exports through aliases solely for old test imports. Avoid a one-to-one wrapper forest.

## Mandatory migration edges

1. Read all callers before moving exports; use LSP references if available (record unavailability honestly), then exact search of known paths/symbols for generated strings and docs. Update every caller/test/generated module URL; remove old implementations.
2. import.meta.url/dirname root assumptions: depth2 internal module root is two parents above its containing directory. Parent-child sibling URL resolution and shipped role definitions must refer to package, not consumer working directory.
3. package.json.files must include nested runtime directories but exclude tests/dev smoke at every relevant depth. Update package-archive/npm-smoke expected inventories and test imports.
4. tools/sync-manifest.json migrates existing module paths and includes actual newly required runtime dependencies (including claims/journal/restore where imported by live entrypoints). No copying node_modules/research/temporary artifacts to public source inventories.
5. Installer copies nested runtime correctly; runtime parser resolution keeps canonical confinement and stable explicit roots. Existing managedFiles preservation uses old identities honestly; do not adopt human files by guessing.
6. Doctor CORE_TOOLS and recursive syntax enumeration cover nested modules using verified real Node, never Bun --check execution. Migrate verify/dashboard/template subprocess paths to actual executable entrypoints only.
7. Source/test hashing must keep current canonical text behavior, secret/state exclusions, frozen test/source acceptance checks and no stale-receipt exceptions. Directory changes do not justify redefining 'source'.
8. Remove genuinely unused helper exports/functions only after checking both internal and external consumers. Earlier report of no EXTERNAL consumer does not establish no INTERNAL consumer (shippedChildPath/sanitizedChildEnv are used inside their own module).
9. Keep useful regressions. Do not repin wording/source/default arrays; migrate behavioral tests and remove incidental tests encountered. No size baseline update, defer waiver, comment/blank-line gaming or test-scope narrowing.
10. Installed-root cutover must not leave obsolete unchanged managed runtime modules as a second implementation. Reuse the existing journal `recordBeforeUnlink(path)` → unlink → `recordUnlinked(path)` for this exact moved-module allowlist only. Require canonical confinement inside the selected installation root, prior ownership hash and current-byte equality; dry-run previews without mutation. Preserve unowned/modified old modules with bounded warnings, and never prune legacy native-home roles/rules/MCP/skills. A failed installation must restore removed owned modules through the existing journal; do not add a migration framework or compatibility shims.

Parent verifies actual CLI imports, nested syntax checking, focused suites, full suite, source/provenance invariants and exact packed npm consumer install/update. No new dependency or migration framework.
