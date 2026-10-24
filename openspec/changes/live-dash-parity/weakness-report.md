# Weakness & bug-hunt report — live-dash-parity (Wave 1+3 recon)

Source: read-only scout sweep of dashboard/workflow/doctor + w2–w4 splits,
parent spot-checked every claim below against file:line.

## Fixed this change (R04, 10/10 + R05 cycles)
1. Stored XSS in `<title>` via unescaped project name — ui:24 → esc().
2. esc() skipped quotes — ui:441 → full entity coverage.
3. Snapshot contract split-brain (`window.STATE` vs `NF_SNAPSHOT`) — mjs:773
   → writes NF_SNAPSHOT (+ legacy alias).
4. Freeze polls live `/api/state` — ui:1267 → guarded by IS_FROZEN.
5. Freeze timers drift — ui:1175,1180 → early return when frozen.
6. ensureDashboard race → dual daemons — mjs:675-730 → single-flight Map.
7. Force-close drops `close` event — workflow:1580 → logged in both branches.
8. Artifact accepts empty openspec dir — workflow:929-948 → requires
   non-empty proposal.md + specs/.
9. doctor-lite silent 1500ms abort → false ok — now warns naming skipped files.
10. checkConfigs PASS on zero configs — doctor-checks:628 → skip.
11. Cycles doctor↔checks, workflow↔workflow-ci → shared leaf modules.

## Rejected (evidence against)
- esc single-quote attr breakout: no single-quoted attr sinks exist.
- pid-less lock 5s freeze: 1s unparsable-cleanup covers it.
- renameSync EBUSY crash: no evidence; Windows read doesn't throw on rename.

## Residual weaknesses (future work, not this change)
- POLL_MS was hardcoded 3000 → now configurable (done); true push (SSE)
  explicitly out of scope per user.
- `embedSnapshot` legacy `window.STATE` alias kept for compat; remove in
  next breaking pass.
- doctor-lite 1500ms budget is wall-clock fragile on loaded CI; consider
  file-count budget instead.
