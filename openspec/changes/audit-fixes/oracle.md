# Oracle verdict

Verdict: ACCEPT

## What was checked

Every claim below was re-run from a clean temp directory against the working tree, not
read from a diff.

| defect | expected after fix | observed |
|---|---|---|
| artifact recorded outside the change dir | refused at record time with the required location | `manifest OUTSIDE change dir: 1 -> manifest.md is outside the change directory 'openspec/changes/probe'` |
| openspec `skip_specs: true` | change recorded | `skip_specs change recorded: 0` |
| corrupt `state.json` | refuse, keep the file | `status` exit 1 with the JSON reason; `start` exit 1; one `.corrupt-*` copy; no new lane |
| unknown tier | refused; T0/T1 still exempt | `['T2'] [] 't2' null undefined 2` all `ok=false`; T0/T1 `ok=true` |
| held reservation | audited release, then admission works | release without reason refused; with reason settled 100 nanoUSD; next admission OK |
| zero-byte legacy marker | refused | `states no reason (0 word(s))` |
| base64 / split secrets | redacted | `b64 leak survives? false`, split-key body fully redacted |
| snapshot refresh | calls exist | `collectDashboardData` and `writeSnapshot` both `function` |
| `--help` | every dispatchable command named | `still missing from --help: (none)` |

## Gates

- `eslint tools/ bin/ bench/checks/` — exit 0
- `code-size.mjs check` — PASS, 303 files, 4 exempt
- `quality.mjs check` — COCO ratchet clean (220 node / 42 python functions)
- `review-budget` + `review-evidence` + `dashboard` — 99 pass / 0 fail
- `workflow-gate` — run separately, see the delivery note

## Reasons, not just verdicts

The fixes were accepted because each one removes a way the harness could have lied to its
operator, and because none of them widened a trust boundary: the ledger still refuses
unknown spend unless a human supplies both the amount and a reason; the review gate still
refuses an unreadable tier; `artifact` now refuses earlier, never later.
