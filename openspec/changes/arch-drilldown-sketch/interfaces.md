# Interfaces — arch drill-down sketch

## 1. Symbol inventory (producer: tools/arch-drill.mjs)

```js
/**
 * @typedef {{ name: string, kind: "function"|"class"|"heading"|"symbol",
 *             startLine: number, endLine: number, lines: number,
 *             internalCalls: number }} SymbolRow
 * @typedef {{ path: string, lines: number, truncated: boolean,
 *             symbols: SymbolRow[] }} FileSymbols
 * @typedef {{ name: string, files: number, lines: number,
 *             children: FileSymbols[] }} ModuleDrill
 * @typedef {{ name: string, files: number, lines: number,
 *             modules: ModuleDrill[] }} ArchDrill
 */
export function collectSymbolInventory(absRoot, relPath, { max = 40 } = {}): FileSymbols
export function collectArchDrill(absRoot, modules): ArchDrill
```

- `collectSymbolInventory` never throws: an unreadable or unparseable file yields
  `{ symbols: [], truncated: false }`. It reuses `scanFile` from `tools/code-size.mjs`,
  so a `.py` file gets `def`, a `.ps1` file gets `function`, and a `.mjs` file gets
  `function`/`const fn`. `internalCalls` is a count of `name(` occurrences inside the
  file minus the declaration itself — a hint, never a call graph.
- `collectArchDrill` walks the same `modules` the tree view already uses, so file
  counts cannot disagree between views. Files are sorted by descending line count and
  capped at 40 per module; a module with more files reports `truncated: true` on the
  module level through the file that was cut (the UI says "ещё N").

## 2. Sketch geometry (producer: tools/dashboard-sketch.mjs)

```js
/** @typedef {{ x:number, y:number }} Pt */
/** @typedef {{ id:string, label:string, sub:string, kind:string,
 *              x:number, y:number, w:number, h:number, level:number,
 *              parents:string[], href:string|null }} SketchNode */
/** @typedef {{ from:string, to:string, weight:number }} SketchEdge */
export function layoutSketch({ nodes, edges }, { width = 900 }): { nodes: SketchNode[], edges: SketchEdge[], w: number, h: number }
export function sketchPath(node, seed): string          // SVG path, hand-drawn box
export function sketchEdgePath(a, b, seed, curve = 0.35): string
export function toExcalidraw(sketch, title): object      // .excalidraw envelope
export function seededRandom(seed: integer): () => number
```

- Determinism is a contract: the same input and the same seed produce byte-identical
  paths, so a 2-second refresh does not make the diagram twitch. The seed is derived
  from the node id, never from `Math.random()`.
- `toExcalidraw` emits only documented element types (`rectangle`, `text`, `arrow`)
  with container-bound text; no `label:` shorthand, no colours outside the skill's
  palette.

## 3. HTTP surface (producer: tools/dashboard-routes.mjs, wired by tools/dashboard.mjs)

- `GET /api/state` → `state.archDrill` (sanitized; strings only, numbers clamped).
- `GET /api/arch.excalidraw?depth=<n>&path=<module>` → `application/json` body with
  `Content-Disposition: attachment; filename="<project>-arch.excalidraw"`. Same Host
  check as every other route; `path` is sanitized to a known module id, never a
  filesystem path.

## 4. UI contract (consumer: tools/dashboard-ui.mjs; implementation: tools/dashboard-arch-client.mjs)

- Mode id `"sketch"`; persisted in `localStorage["nf-arch-mode"]` next to the other
  three. Breadcrumb state lives in a module-level array, not in the URL.
- Keyboard: `Esc` pops one drill level while the modal is closed, and only then falls
  through to close the modal.
- The renderer draws into the existing `#arch-canvas` with an `<svg>` of the same
  class family, so zoom and the detail panel keep working.

## 5. Ownership

| Zone | Files | Owner |
|---|---|---|
| Symbols + drill tree | `tools/arch-drill.mjs` (new) | one writer |
| Sketch geometry + export | `tools/dashboard-sketch.mjs` (new) | same writer (the export depends on the layout) |
| Sanitizers + HTTP routes | `tools/dashboard-routes.mjs` (new) | same writer |
| Client tab (render, CSS, labels) | `tools/dashboard-arch-client.mjs` (new) | same writer |
| Wiring only | `tools/dashboard.mjs`, `tools/dashboard-ui.mjs`, `tools/dashboard-collectors.mjs` | same writer |
| Tests | `tools/tests/dashboard-sketch.test.mjs` (new, 13 tests) | same writer |

One writer for all five: the collector shape is consumed by the sketch, the route and
the renderer in the same pass, and splitting it would require an interface freeze
before a single line works.
