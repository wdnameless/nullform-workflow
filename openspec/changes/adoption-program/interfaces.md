# adoption-program — interfaces

## A1 settle
`confirmSettle(flags)` and `resolveSettleTargets(root, change)` remain public;
target confirmation must be explicit and safe. `removeSettleBranches` and
`removeSettleWorktrees` return/throw failure rather than swallow it.
CLI accepts `settle <change> --yes` and `settle --change <change> --yes`.

## A2 install smoke
Existing installer/verifier APIs reused. CI creates isolated root/home,
performs real install for claude/codex/opencode, then verifies target.

## A3 listeners
Test helpers use active OS-assigned listener or server-bound address;
no free-port close/relisten.

## B1 verify
`resolveRoots(opts)` retains path compatibility; path root no longer forces
Claude. `--harness-root` remains explicit alternative.

## B2 experience
`checkExperienceFresh(root, startedAt)` validates fresh content with
`cue | lesson | evidence`, not just mtime.

## C1 scope
Existing `changed-scope.mjs` gains advisory scope report using unified diff
and intent. Offline, no writes, JSON output.

## C2 skills
Existing skill audit seam gains security/eval/registry checks and near-miss
fixtures. No execution of scanned code.

## C3 worker
Existing return contract validates complete input, INPUT GAP and fresh FIX
redispatch semantics. No new advisor.

## C4 dependency
Offline manifest diagnosis JSON; no auto-edit, no CVE completeness claim.

## C5 optimizer
Existing eval/budget seam returns baseline/candidate results and candidate
artifact paths; no prompt mutation; spend ≤$10.

## Ownership
Phase A: fixer A1/A2/A3 disjoint. Phase B: fixer B1/B2 and registry/docs B3.
Phase C: fixer C1/C2/C3/C4/C5 bounded by existing seams. Parent integrates,
runs gates and final oracle.
