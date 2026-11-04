# Proposal — gates-coco-prune (s3-gates)

## Why
`tools/quality.mjs` exceeds its defer ceiling (804 lines vs 700 ceiling). Functions `sync.mjs:main` (315 lines) and `usage-audit.mjs:auditUsage` (208 lines) exceed the 200-line COCO/function ceiling. In addition, 9 unwired experimental/orphan modules remain in `tools/` without production callers.

## What Changes
1. Split `tools/quality.mjs` by extracting engine logic into a supporting module so `quality.mjs` remains well below the 700 line ceiling with >5% margin, maintaining backward compatibility of all exports and CLI commands.
2. Refactor `tools/sync.mjs:main` (315 lines) into focused sub-routines to bring `main` under 200 lines.
3. Refactor `tools/usage-audit.mjs:auditUsage` (208 lines) into focused sub-routines to bring `auditUsage` under 200 lines.
4. Prune the 9 unwired modules (`asset-freeze.mjs`, `blind-accept.mjs`, `capsule.mjs`, `checkpoints.mjs`, `coverage-check.mjs`, `fallback.mjs`, `supervision.mjs`, `two-phase.mjs`, `usage-normalize.mjs`) along with their test files after verifying 0 production callers via grep. Clean references in CODEMAP.md files.
5. Verify COCO ratchet records only downward movements (min-recorded). Ensure zero behavior change and 100% passing tests.
