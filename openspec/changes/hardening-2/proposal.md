# Why
Yesterday's scoring pinned the three real gaps: acceptance quality depends on a flash oracle that fabricates without an explicit protocol; the registry carries 38 skills and 4 MCP servers unused in 90 days; the harness silently accumulates files that no longer exist in the repo (sync copies, never prunes). Plus the operator asked for a bug hunt.

## What Changes
- Oracle evidence protocol baked into the role; double acceptance for flash-class oracles; oracle-lite for small T2.
- Adversarial bug hunt across tool and infra surfaces with regression tests for every defect.
- `doctor` orphan check + `sync -Prune` (dry-run first).
- `.skills-disabled.json` honored by skills-doctor; 90-day-unused skills moved out of the registry; garbage MCP entry removed.
- First **real** benchmark: `omp -p` arms on a throwaway repo, raw evidence archived.

## Impact
Four disjoint workers (prompts/docs · tools hunt · infra hunt+prune · registry pruning) + Main running the benchmark; oracle for this lane uses the new protocol (dogfood).
