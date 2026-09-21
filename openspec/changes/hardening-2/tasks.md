# Tasks
- [x] A: oracle evidence protocol + double acceptance + oracle-lite + weekly memory review + docs
- [x] B: adversarial bug hunt — 17 defects fixed across 6 tools (+2 found by the live benchmark itself, +3 flag-validation defects in the re-review round)
- [x] C: doctor orphan-files + `--probe` provider reachability + oracle-model reachability + `sync -Prune` (+4 workflow.mjs defects, +1 sync-prune guard)
- [x] D: skills disable-list mechanism + reference-checked pruning (1 of 23 moved; 22 kept by design, accounting complete: 15 lock-managed + 17 palette + 4 paseo + 1 feature) + mcp.json garbage entry removed
- [x] Main: real benchmark (2 tasks × 2 arms × n=2, `omp -p`), provider-outage blocker found and rerouted, results archived under benchmark/
- [x] Double oracle: A = ACCEPT, B = REJECT (flag-validation false green) → fix round → B re-verified ACCEPT; commit, push
