# Oracle verdict — arch drill-down sketch (T2)

Verdict: **ACCEPT**

Judged blind against `manifest.md` (the user's verbatim quotes) and the running
dashboard at `http://127.0.0.1:4399`, not against `proposal.md` or `specs/`.

| ID | Verdict | Evidence |
|---|---|---|
| R01 «детальный лайв дешборд как здесь» | proven | The tab polls `/api/state` every 2 s like the others; the sketch pulls its own geometry from `/api/arch.sketch`. Counters in the header (`файлов 1 485 · строк 228 898`) come from live state. `--freeze` snapshot still renders (no fetch path taken when `IS_FROZEN`). |
| R02 «рисовать нам через excalidraw или аналог» | proven | Hand-drawn render: every box is a closed jittered path drawn twice with a 1.2 px offset, seeded from the node id, so no refresh makes it twitch. `.excalidraw` export validated structurally: `type:"excalidraw"`, `version:2`, 62 elements, 0 missing core fields, 0 orphan text, 0 duplicate ids, every text container-bound, no `label:` shorthand. |
| R03 «вначале высокий слой» | proven | Opening the tab draws 11 boxes: the project plus 10 modules, with module-to-module edges. `g.sk-box[data-file]` count is 0 and no symbol node exists at this level. |
| R04 «с возможностью погрузиться все ниже и ниже» | proven | Click `tools` → 13 boxes, 12 file nodes, breadcrumb `workflow-repo › tools · назад`; click `dashboard.mjs` → 41 boxes, file plus 40 symbols with line ranges; `Esc` returns to the module level, a second `Esc` to the project level, with the modal untouched. Zero page errors across the run. |

Independent check of the claim "no new dependency": `git status` shows no change to
`package.json`; the sketch module imports nothing outside `node:*`.

Residual concerns (not blocking):

- The `.excalidraw` file was validated structurally and against the documented element
  schema, not by opening excalidraw.com in a browser (no network in this run). The
  envelope matches the skill's reference example field for field.
- `internalCalls` in the symbol view counts same-file sibling calls only. The UI labels
  it `↻`, never "calls N", so the weaker claim is the one on screen.
- `code-size` carries a `defer:` header on `dashboard-ui.mjs` naming the 6 injected lines
  and their upgrade trigger; `tools/quality.mjs` reports 4 violations that all predate
  this change (`trajectoryOf`, `runReviewRecord`, `validateOpenspecArtifact`,
  `validatePlanCoverage`) and lie in files this change does not touch.
