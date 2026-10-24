# Legacy acceptance

This change was accepted and merged **before** the native review-evidence
mechanism existed (first commit: 2026-10-18). No `review-evidence.json` can be
produced retroactively: a native execution record describes a run, and no run
of this change can be replayed into the past.

Accepted on the strength of its committed `oracle-verdict.md` (explicit ACCEPT
verdict, verifiable in git history). This marker exists so the exemption is
explicit and reviewable, not a silent pass.

Do not add this marker to new changes.
