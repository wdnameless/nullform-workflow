# Integration contract

Baseline c1b29e2; branch feat/portable-release-integration. Requirements are manifest.md R01-R09. Every builder reads current source before choosing internal helpers. Reuse existing Node modules, parser dependencies and filesystem guards; no new runtime dependency without source-verified need.

## Ownership

RuntimeOwner: bin/nullform.mjs; tools/install-harness.mjs, installation-state.mjs, self-update.mjs, doctor.mjs, harness-config.mjs, workflow.mjs; required new deployment/capability modules; corresponding runtime tests. Owns generated adapter prompt strings only. No package/version/CI/docs or historical evidence writes.

CertificationOwner: package.json, package-lock.json, VERSION; tools/npm-smoke.mjs, existing npm registry/distribution helpers and tests; .github/workflows/repo-gate.yml, new npm publish workflow and shipped CI template; required package-certification/release scripts. Owns metadata/version and immutable archive contract. No runtime implementation or historical evidence writes.

EvidenceOwner: required quality-evidence module/data/tests; tools/lm-replay.mjs, relevant benchmark/results/evidence tests when a reproduced provenance defect requires correction; bench/README.md, README.md, CONTEXT.md, relevant docs/core/role/rule/skill prompt sources. Does not change generated adapter renderer or public CLI dispatcher. Never edits raw retained sessions, comparisons, spend ledger or unrelated eval-metrics manifest/transcript.

Parent alone: this manifest/specs/interfaces/tasks/ExecPlan/progress, integration git, artifact verification and reconciliation. Writers isolated, no mid-flight build/lint/tests/formatters; parent runs acceptance after integration. Public signature changes require references first (LSP unavailable; exhaustive grep fallback) and messages to parent.

## Stable consumers and behavior

Keep installHarness(options) and existing init/doctor/update public behavior; add only necessary explicit recovery information. read/writeInstallationState remains schema-validated and writes the last verified identity atomically. Runtime consumers must never mistake globally upgraded npm binary plus failed target application for a fully updated installation. Retry/recovery must preserve human edits and reject journal/path escapes.

Expose core project gates through `nullform workflow <existing-command> ...` using the existing workflow parser/dispatch/implementations, not shell interpolation or copied business logic. Its project root defaults to cwd; basic operations never require OMP/Bun. Review capability is explicitly separate from configuration-adapter readiness. Certification measures eight configuration adapters, not undocumented native model execution.

Expose `nullform capabilities [--json]` or equivalently explicit doctor capability output, plus `nullform evidence [--json]` backed by EvidenceOwner module. EvidenceOwner exports `readQualityEvidence({root})` returning validated historical observations/limitations and `claimStatus`, never dispatching model/network calls. RuntimeOwner owns only dispatcher integration; message EvidenceOwner if a compatible exact signature is needed. Installed packages include a sanitized source-bound evidence summary under core/, generated from retained records rather than handwritten success claims. Missing/invalid evidence is an explicit unknown/error status, not a positive fallback.

CertificationOwner exports or provides CLI `certify-package --tarball PATH --json [--output PATH]`: consumes supplied bytes, verifies name/version/dependency/assets/integrity, runs actual isolated npm install/selected-host configuration/reapply/upgrade, and emits certificate binding tarball sha256/sha512, package version, source commit, OS/architecture and Node/npm versions. `tools/npm-smoke.mjs --tarball PATH` must never repack the candidate under certification. Its local future-upgrade fixture uses a derived higher version, not fixed1.2.0. Producer packs once; every matrix consumer/publisher verifies the same digest.

Maintained certification targets: hosted Ubuntu/Windows/macOS x Node22/24. Preserve existing declared runtime compatibility unless an actual required API forces a reviewed engine change; documented certified support and engine range are distinct. Intended public release1.2.0; version bump uses one canonical VERSION/package/lock agreement and explicit rationale. No arbitrary baseline edits/defer exemptions.

Public publishing is authorized only after integrity, hosted matrix and independently observed release-candidate acceptance bound to the current source/archive. Candidate acceptance is not proof that external publication occurred; final program completion still requires actual published-registry verification. For the unpublished name, initial bootstrap requires user-controlled npm web authentication to publish the real certified package, then owner configuration of hosted OIDC for subsequent releases. Never commit/copy/request tokens, publish a placeholder registration package, claim publication from dry-run, or change personal profiles. Bind the first release to verified build attestation/source/checksum; expose any npm-provenance limitation explicitly instead of forging it.
