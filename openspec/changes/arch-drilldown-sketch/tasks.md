# Tasks — arch drill-down sketch

- [x] P01 Collector: `collectSymbolInventory`, `collectArchDrill` in tools/arch-drill.mjs (extracted from collectors to keep that file flat; reuses `scanFile` from code-size.mjs). Acceptance: 5 unit tests — .mjs, .py, unparseable, missing file, cap flag.
- [x] P02 Sketch: tools/dashboard-sketch.mjs — level assignment, column packing, deterministic hand-drawn paths, `toExcalidraw`. Acceptance: double render byte-equal; envelope has no `label:` shorthand and every text is container-bound.
- [x] P03 Server: tools/dashboard-routes.mjs — `sanitizeArchDrill`, `sanitizeArchState`, `serveArchRoute`, `serveDiffRoute`; `/api/arch.sketch` + `/api/arch.excalidraw`. Acceptance: HTTP 200 with Content-Disposition; body validates as an excalidraw envelope (62 elements, 0 orphans, 0 duplicate ids).
- [x] P04 Renderer: tools/dashboard-arch-client.mjs — mode "sketch", breadcrumbs, Esc/back, export button, CSS and RU/EN labels injected into the template. Acceptance: browser smoke — project (11 boxes) → tools (13) → workflow.mjs (41) → Esc ×2 returns; zero page errors.
