# Interfaces and ownership

## Integration and verification owner

Parent owns specs/manifest/interfaces, contained Git integration, actual before/after verification, final docs reconciliation and release gates. Source base is 29f7185. Keep no-paid/no-OpenRouter/no-gateway/no-secret-read constraints. A normal assistant coding session is not a comparative quality experiment; workers may not dispatch additional model calls or use semantic judge auxiliaries. All temporary files stay own root/.tmp or OS temp. Workers skip tests/build/lint/formatters mid-flight; parent executes once at each integration boundary.

## SafetyOwner: six audited defects (R01)

Owns tools/review-evidence.mjs, tools/review-http-evidence.mjs, tools/review-budget.mjs, tools/workflow.mjs and their focused existing review/budget/CLI tests; a focused new regression file is allowed if existing fixtures cannot express a transition. No packaging/installer/policy changes. First deliver TEST-ONLY failing regressions, stop for parent before-run, then source fixes after GO.

Preserve runReviewRecord, validateReviewEvidence, project/reproject/validateHttpRecord, admitSession/recordRequest/settleReservation/inspectBudget and public CLI commands. Minimal shared product-execution invariants may be extracted only when both native and HTTP consume them, with one-way dependency and no wrapper-only API. HTTP ACCEPT must require actual product execution with valid command/source/hash/time and exitCode0 just like native. Retained-run overflow or unknown scan state cannot authorize a fresh run. Ordinary retry refuses matching completed work, explicit resume imports without dispatch, explicit redo may start a fresh admitted cycle while preserving history; --redo and --resume-session remain mutually exclusive.

Ledger writes must never strand an admitted operation past the reader byte ceiling. Reserve sufficient persistence space for the admitted session's bounded request records and terminal accounting BEFORE authority is granted, or implement a proven safe bounded history representation retaining cumulative spend and unresolved authority. Do not merely fail settlement after paid work, silently trim history, loosen the read bound or add a DB. MaxRequests remains bounded and captured. Dry-run missing policy reports unavailable admission/prerequisites and no budget authority or state writes; supplied malformed/unsupported policy still refuses. Forward actual trailing positional count into existing review flag validation.

## SetupOwner (R03,R09,R10)

Owns bin/nullform.mjs, installer/profile/adapter/config modules and their focused tests after primary-source research. Reuse existing prompt session/menu, state/journal, command-path detection and confinement. Exact one-command goal: npx --yes nullform-workflow@latest init. Explicit --harness wins; saved selected installation stays stable; a single evidenced candidate can be selected with preview; several candidates require selection; no candidate offers existing supported menu/manual selection, never silently chooses OMP. --yes/non-TTY ambiguity refuses with actionable flags before writes. Detection reads bounded presence/metadata only, not credentials, auth or user instructions, and does not start client/model processes. Selection can configure an explicitly requested absent client but must disclose that native session behavior is unverified.

Native instruction placement and human preservation follow primary-source evidence for each client; do not call OpenHuman OpenHands. No default MCP bundle/task tracker/global full skill catalogue. Our policy changes are repository assets only, not the live user's configuration. All existing named adapters/custom contract remain explicit; an absent runtime is not a passing live E2E.

## StructureOwner (R04,R05; blocked by integrated safety/setup)

One integration owner performs the cutover after semantic fixes: actual executable files remain bin/nullform.mjs and tools/workflow.mjs, doctor.mjs, install-harness.mjs, verify.mjs; internal review/installation/workspace modules group in feature directories only where the inventory justifies them. Move implementations, migrate all imports/generated paths/tests/docs/package/sync inventories and import.meta.url/REPO_ROOT assumptions, remove old implementations with no shims/re-exports. Doctor must syntax-check nested shipped modules with real Node. Package includes nested runtime but excludes tests/dev smoke; installation copies nested dependencies correctly. Source/test hashing and acceptance exclusions must retain their existing meaning; no stale-receipt exception or basename workaround. No baseline waiver or comment/blank-line size gaming. Preserve semantically valid regressions, remove source-text/default-pinning tests rather than repinning them.

## Evidence/docs owner (R02,R06-R08,R11-R12; parent reconciles)

Primary-source links + compatibility matrix explicitly distinguish documented/configured/loaded/executed. Document root navigation, the single setup command, headless/ambiguity/reapply/error paths, safety and no-sandbox limits, verification commands and exact tarball release gates. Deterministic fixtures establish error prevention/recovery, not model quality. No universal-superiority claims. Remove obsolete instructions and stale workflow copies only by clean cutover of our own assets; never edit installed personal prompts.

## Gate order

G2: independent brief/spec coverage before source GO. Parent failing-before tests for SafetyOwner. Integrate safety/setup disjoint sources before structural cutover; focused real CLI and loopback smoke after each semantic boundary. Final full suite + size + actual packed install/update + evidence inventory. Stage-B simplification against frozen tests. Blind acceptance against manifest and running artifact, never our spec; no paid provider run and no fixture masquerading as release acceptance. Missing native-acceptance/registry prerequisites are explicit blockers while every reachable verification is completed.
