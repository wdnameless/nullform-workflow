# Oracle — adoption-program

Verdict: **ACCEPT** (2026-11-05, @oracle retry after ECONNRESET).
Blind against `manifest.md` R01–R12 and running master `8930427`.
No code changes by oracle. No live model quality claimed.

## Evidence

- R01 settle guards: task-claim 66/66; protected refs at workflow-ci.
- R02 real isolated install smoke: install-smoke-r02 1/1 across claude/codex/opencode + doctor.
- R03 listener race: replay 9/9, dashboard 32/32.
- R04 positional settle: task-claim positional matches --change.
- R05 harness path: verify-matrix 8/8; path root no forced Claude.
- R06 experience: experience tests 7/7, valid cue|lesson|evidence.
- R07 scope: changed-scope 10/10 deterministic advisory.
- R08 skills: skill-security 8/8, security/evals/trigger/registry.
- R09 worker: return-contract 31/31, INPUT GAP + fresh FIX.
- R10 dependency: dependency-doctor 19/19 offline read-only.
- R11 optimizer: bench-optimizer 12/12 candidate-only, max $10; live model UNVERIFIED.
- R12 deterministic Windows Node v24.17.0; live provider quality UNVERIFIED (no credentials in sandbox).

## Gates

- Focused suite: **351 pass / 0 fail**.
- Quality: `node pass (223 functions)`.
- Code-size: `PASS (294 files, 2166 functions, 4 exempt)`.
- Full suite: 1512 pass / 8 fail; residual controlled-http ETIMEDOUT under load; isolated controlled-http **32/32 pass**.
- Additional spend: **$0.00**, optimizer ceiling **$10.00**.

## Limitations

- Python pylint unavailable locally: `No module named pylint`; not treated as a code pass.
- Live model quality and live provider execution are **UNVERIFIED**, not simulated.
- Oracle first attempt failed with ECONNRESET; retry completed successfully.
