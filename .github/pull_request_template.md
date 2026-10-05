name: Pull request
about: Change description with evidence, merge danger, and blast radius
---

## Summary

<!-- What changed and why, in 2-5 sentences. For refactors: name the duplicated concepts merged and the call sites affected. -->

## Evidence (before → after)

<!-- REQUIRED: runtime proof the change does what it claims. Paste the exact command plus raw output/counts. A PR without evidence is not ready for review. -->
<!-- Examples: `node --test tools/tests/<name>.test.mjs` → `pass 12, fail 0`; screenshot before/after; replay cassette verify output. -->

- Command:
- Before:
- After:

## Merge danger

<!-- One-way (hard to roll back: data migration, irreversible public action, external side effect) or two-way (plain revert restores prior state). -->

- [ ] Two-way door — safe to revert
- [ ] One-way door — rollback is expensive/destructive because:

## Blast radius

<!-- Small (isolated module, few callers) / Medium (shared contract, several callers) / Large (cross-cutting, public API, data shape). Name the affected surfaces. -->

-
