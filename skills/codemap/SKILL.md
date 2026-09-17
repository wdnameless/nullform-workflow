---
name: codemap
description: Hierarchical repository cartography with incremental change tracking. Use when entering an unfamiliar repo, when planning a large change, or before deep work in an unknown folder.
---

# Codemap — Repository Cartography

Build and maintain a persistent map of the codebase so agents stop re-reading the
same files every session. The map is stored **in the repo** (`CODEMAP.md` per
folder), so it survives across sessions and is reviewable in git.

## Engine

`<HARNESS>/tools/codemap.mjs` (installed by `install.ps1`; zero dependencies, Node 18+/Bun):

```bash
node <HARNESS>/tools/codemap.mjs init   --root . --include "src/**/*.ts" --exclude "dist/**"
node <HARNESS>/tools/codemap.mjs changes --root .    # what changed since last update
node <HARNESS>/tools/codemap.mjs update  --root .    # commit new hashes
```

State lives in `.codemap/state.json` (gitignored). Scan config (`--include` /
`--exclude`) is persisted in state, so `changes`/`update` need no repeated flags.

## Workflow

1. **Entering an unfamiliar repo / large plan** → run `init` (or `changes` if
   `.codemap/state.json` already exists — never re-init).
2. **`changes` output lists affected folders.** Delegate ONE `@fixer` per
   affected folder to write/update that folder's `CODEMAP.md`. Folders are
   independent → batch them in a single `task()` call with disjoint ownership.
3. **`update`** to commit the new hashes.
4. **Root `CODEMAP.md`** aggregates sub-maps: write a Repository Directory Map
   table (`Directory | Responsibility | Detailed Map link`).

## CODEMAP.md content (per folder)

- **Responsibility** — the folder's role in standard terms: Service Layer, DAO,
  Middleware, Facade. Not a file listing.
- **Design Patterns** — named patterns actually used (Observer, Strategy,
  Repository) and the abstractions behind them.
- **Data & Control Flow** — how data enters and leaves; call sequences and state
  transitions.
- **Integration Points** — dependencies and consumers; name hooks, events,
  endpoints, shared types.

## Rules

- Cartography artifacts (`CODEMAP.md`) are NEVER tracked by the engine itself.
- A folder with no behavioural content (assets, fonts) needs no map.
- Do NOT use this for a 2-file change — it is a reconnaissance tool, and its cost
  only pays back on unfamiliar or large surfaces.
- `CONTEXT.md` (domain glossary, `skill://domain-modeling`) and `CODEMAP.md`
  (code structure) are complementary: one names the concepts, the other locates
  the code. Neither duplicates the other.
