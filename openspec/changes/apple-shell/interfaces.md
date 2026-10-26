# Interfaces — apple-shell

## 1. Waiting state (producer: tools/workflow.mjs; consumer: the collector)

```
workflow ask <kind> --note "<what we wait for, one line>"
workflow answered
```

- Kinds: `briefing | spec | plan | action | stop` — anything else is a usage error, so a
  typo cannot silently create a state the dashboard will not colour.
- `ask` writes `state.waiting = { kind, from, note }`. A second `ask` with a **different**
  kind closes the previous interval into `state.waits` first, then opens a new one; a
  second `ask` with the same kind is idempotent and keeps the original `from`, so a
  repeated message does not reset the clock the human is being measured against.
- `answered` closes the interval: append `{ kind, from, to, durationMs }` to `state.waits`,
  delete `waiting`. Calling it with no open wait is a no-op that exits 0 — the agent may
  answer defensively.
- Both go through the existing `withStateLock`, so a concurrent `artifact` cannot
  interleave.

## 2. Collector additions (tools/dashboard-collectors.mjs)

```js
/** @typedef {{ kind: string, from: string, to: string, durationMs: number }} Wait */
/** @typedef {{ envKeys: string[], placeholders: {file:string,line:number,text:string}[],
 *              assumptions: string[] }} Needed */
/** @typedef {{ checked: number, matched: number, disagreements: string[],
 *              source: string|null }} Blind */

export function collectNeeded(absRoot): Needed
export function collectBlind(absRoot, change = null): Blind | null
```

- `collectNeeded` reads only names, never values: a `.env.example`/`.env.sample` line
  `NAME=` or `NAME=changeme` contributes `NAME`; a value that looks like a real secret is
  never read into the result at all. Placeholders come from `PLACEHOLDER`, `TODO:` and
  `defer:` markers with a `ceiling`, capped at 40 rows. Assumptions come from manifest
  rows whose status column says `assumption`/`assumed`.
- `collectBlind` parses the newest `oracle*.md` (or `acceptance.md`) in the change dir:
  a table row whose verdict cell says `proven` counts toward `matched` **and** `checked`;
  `partial`/`missing` count toward `checked` and become a disagreement string
  `"R07 — <why>"`. Returns `null` when no such file exists, so the card is absent rather
  than empty.
- Both are pure readers: no network, no subprocess, no mutation.

## 3. Checks age (same module)

`collectCritique` gains `checksAge: { days: number|null, stale: boolean }`, derived from
`dashboard-checks.json`'s `generatedAt`. `stale` is `days > 1`. A cache without
`generatedAt` reports `days: null, stale: true` — an unaged cache cannot be called fresh.

## 4. Presentation (tools/dashboard-shell-client.mjs, new)

The three new cards and the material/type/motion CSS are generated here as source text and
injected into the page, the same way the arch tab already does it. Contract:

```js
export const SHELL_CSS = String.raw`…`;        // materials, type scale, motion, a11y
export const SHELL_CLIENT_JS = String.raw`…`;  // renderNeeded, renderBlind, checks badge
```

- Reason for a module rather than inline template text: the template is already at its
  size ceiling; a second growing block would move the ceiling again instead of paying it
  down.
- The client functions read only from `DATA.run` / `DATA.metrics`, never re-fetch.

## 5. Ownership

| Zone | Files | Owner |
|---|---|---|
| Waiting producer + CLI | `tools/workflow.mjs` | one writer |
| Collectors | `tools/dashboard-collectors.mjs` | same writer |
| Shell presentation | `tools/dashboard-shell-client.mjs` (new) | same writer |
| Template wiring | `tools/dashboard-ui.mjs` | same writer |
| Tests | `tools/tests/apple-shell.test.mjs` (new) | same writer |

One writer: the collector shape is consumed by the client in the same pass; splitting it
would need an interface freeze before anything runs.
