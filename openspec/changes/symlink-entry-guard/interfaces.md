# Interfaces — symlink-safe CLI entry guards

## Boundary

Every shipped CLI module under `tools/*.mjs` that is both a library and an
executable owns one private direct-run predicate. It decides whether the module
was started as the process entry point. It is not exported and not part of any
public interface.

## Contract

| Name | Kind | Signature | Owner |
|---|---|---|---|
| `isDirectRun` (per-file) | local predicate | `(argv1: string \| undefined) => boolean` | each `tools/*.mjs` |
| `_isMainModule` | exported predicate | `(argv1?: string, metaUrl?: string) => boolean` | `tools/lib/*` helper, if the fixer chooses a shared module |

Semantics: true when the module is the process entry point, **including when any
parent directory of the invoked path is a symlink**.

## Rules

1. Identification is by filesystem identity, not string equality: both sides are
   resolved with `realpathSync` before comparison.
2. `realpathSync` throws when the path does not exist (e.g. `node -e`); the
   predicate MUST catch and return `false` rather than propagate.
3. Files whose current behaviour is unconditional — `sync.mjs` (top-level
   `main()`), `codemap.mjs`, `glossary.mjs`, `replay.mjs` — keep their current
   contract and are out of scope.
4. Six files already carry a filename-suffix fallback
   (`cache-doctor.mjs`, `cache-policy.mjs`, `return-contract.mjs`,
   `context-inbox.mjs`, `domain-context.mjs`, `memory-cadence.mjs`). They are
   migrated onto the realpath predicate so one rule governs the tree; the
   suffix fallback is then dead weight and MUST be removed.

## Seam

The seam is the predicate itself: a pure function of the two paths, testable
without spawning a process. The regression test crosses the seam through the
real filesystem (junction/symlink), because the defect only exists there.

## Ownership

Single writer: `SymlinkGuardFix`. No other agent touches `tools/*.mjs` while it
runs. `openspec/changes/symlink-entry-guard/**` is written by the orchestrator.
