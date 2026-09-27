# Blind acceptance — workflow risk remediation

Verdict: ACCEPT

Two independent read-only passes on `nullform-gateway/gemini-3.8-flash-high` (`agent://RemediationOracleA`, `agent://RemediationOracleB`) judged the running product against the verbatim quotes in `manifest.md` (R01–R14), without reading this plan, the specs, or the earlier audit report. Both returned ACCEPT; neither found a surviving defect. Raw verdicts: `agent://RemediationOracleA`, `agent://RemediationOracleB`.

## Independent evidence

Both passes re-ran the deterministic gates themselves and reproduced the consumer-visible scenarios rather than trusting the parent:

- suite `415/415`; `verify` `29/29`; `audit` `15/15`; `code-size` `PASS (112 files, 753 functions)`; `sync --check` `clean (62 files)`.
- Oracle A: relative-root promote `exit 0` with punctuation intact and real root substituted; three rule copies converged; isolated OMP install plus installed-mode doctor `exit 0`; PowerShell dummy-secret substitution `exit 0`; nested `--root` refused `exit 2` before any filesystem mutation; all 14 live plugin versions match the pins, and the Python/npm versions were read from the registries.
- Oracle B: traversal session key rejected at `tools/dashboard.mjs:739` with the outside file untouched; two sessions never share a server while same-session reuse stays idempotent; T1 without `--recon` refuses; a split ACCEPT+REJECT oracle pair is blocked; a tracked `src/credentials.ts` edit after acceptance makes the close stale; guarded auto refuses an out-of-scope path; local T2 refuses a thin artifact set.

## Requirement coverage

R01–R13 proven by both passes. R14 is **partial by design**: the oracle cannot mutate git state, so the commit, push and remote CI observation belong to the parent and are performed after this record.

## Limits

Native POSIX execution of `install.sh` is **not proven on this Windows host** — the POSIX path is covered by the bash syntax test and the CI matrix on `ubuntu-latest`/`macos-latest`, not by a local run. Remote CI results are not observable from this workstation; the parent verifies them after the push. The earlier audit's finding 7 (installing into a nested source subtree) is fixed by refusing the destination, not by making the copy recursion safe for such a destination.
