# Manifest — adoption program

Source: user "Приступай и бери все что нам нужно по порядку" (2026-11-05)
+ Wave 0 selections "План + optimizer", "До $10", "Candidate-only, без
автоприменения" + `.tmp/recon-adoption-program.md`.

criticality: supporting

## Requirements

| ID | Requirement | Verbatim quote | Status |
|----|-------------|----------------|--------|
| R01 | Settle guarded: only intended existing worktree/branches, protected/current refs never deleted, errors fail | "Приступай и бери все что нам нужно по порядку" | in-spec |
| R02 | Real install-smoke: install into isolated root/home then verify target | "все работало" | in-spec |
| R03 | Port allocation without TOCTOU race in replay/dashboard tests | "все работало" | in-spec |
| R04 | Positional and flag settle forms work identically | "Приступай" | in-spec |
| R05 | Harness path and name semantics agree with target root and agent dir | "на разных системах и харнессах" | in-spec |
| R06 | Experience content validated; registry duplicates/orphans resolved; workflow-ci entrypoint/codemap coherent | "поддерживаемый код" | in-spec |
| R07 | Deterministic advisory scope classifier using existing changed-scope | "берем ... по порядку" | in-spec |
| R08 | Skill security scan, per-skill evals, near-miss trigger fixtures, registry lint | "берем все что нам нужно" | in-spec |
| R09 | Worker brief with full inputs, INPUT GAP, FIX fresh redispatch in existing contract | "по порядку" | in-spec |
| R10 | Offline dependency manifest diagnosis, no silent edits, not CVE scanner | "берем все что нам нужно" | in-spec |
| R11 | Candidate-only optimizer baseline→one mutation→reeval→keep/revert, max $10, no auto-apply | "План + optimizer" | in-spec |
| R12 | Executed proof on available systems/harnesses and explicit UNVERIFIED elsewhere; no quality overclaim | "доказуемо" | in-spec |

## Constraints

- C1: Phase order A→B→C→D, validation/oracle per phase.
- C2: No automatic prompt edits; no new advisor runtime/frontend/ADK.
- C3: Optimizer $10 extra, admitted transport only, ledger evidence.
- C4: No new external dependency unless existing tooling insufficient.
- C5: No silent branch deletion or fallback-to-host verification.
- C6: Live model quality remains `not-proven` without paired A/B.

## Product quality contract

| Field | Value |
|---|---|
| actor/action/outcome | developer → workflow/settle/install/skill CLIs → safe deterministic result |
| workload/environment | current repo; Windows local; CI Ubuntu/Windows/macOS Node 18/20/22/24 |
| limits | no protected/current branch deletion; no network for scanners/classifier/dependency doctor; optimizer ≤$10 |
| command | focused test files + sandbox settle + isolated install-smoke + full suite |
| required | R01–R12; live model optimizer evidence only if admitted provider available |
| raw evidence | exit codes, branch list, JSON reports, test counts, spend ledger |
