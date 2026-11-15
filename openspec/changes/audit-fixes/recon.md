# Recon — files touched and acceptance check

## Files touched

| file | change |
|---|---|
| `tools/workflow-core.mjs` | one state reader (`readState`), quarantine of an unreadable state, `changeScopeProblem`, `declaresSkipSpecs`, `refuseOnCorruptState` |
| `tools/workflow/artifact.mjs` | new: `artifact` recording, split into path / shape / detail validators |
| `tools/workflow.mjs` | thin adapters for `artifact`, `budget-release`, corrupt-state refusal in `start`/`status`/`check` |
| `tools/review/evidence.mjs` | unknown tier refused, legacy marker must state a reason, Stage-B checks extracted |
| `tools/review/budget.mjs` | `releaseHeldReservation`, `withReservationInStatus` |
| `tools/review/redact.mjs` | new: redaction covering base64 and newline-split secrets |
| `tools/installation/capabilities.mjs` | `--help` documents the seven hidden commands |
| `tools/doctor-checks.mjs` | stale install names `nullform update` as the remedy |
| `agent/AGENTS.md` | new §3 SURGICAL DIFF with the do-not-touch list; sections renumbered |
| `.code-size.baseline.json` | reseeded for the three files whose growth the fixes justify |

## Acceptance check

Every finding is re-verified by its own probe in `.tmp/`:

```
node .tmp/probe-manifest-location.mjs   # artifact refuses outside the change dir
node .tmp/probe-skip-specs.mjs          # skip_specs change is recorded
node .tmp/probe-corrupt-state.mjs       # status/start refuse, lane quarantined not lost
node .tmp/probe-tier-array.mjs          # every non-tier value refused
node .tmp/probe-held-fix.mjs            # release needs a reason, then admission works
node .tmp/probe-legacy.mjs              # zero-byte marker refused
node .tmp/probe-redact.mjs              # base64 and split-key secrets redacted
```

Plus the three gates (`eslint`, `code-size`, `quality`) and the touched suites
(`review-budget`, `review-evidence`, `dashboard`, `workflow-gate`).
