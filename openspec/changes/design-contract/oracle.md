# Design Contract Oracle Acceptance

Verdict: ACCEPT

## Evidence by Manifest Requirement

- **R01 (Canonical DESIGN.md Structure)**: Proven. `templates/design/DESIGN.md` defines 5 canonical sections in the documented order: 1. Canvas & tokens, 2. Reference lock, 3. Imagery strategy, 4. Do / Don't, 5. Examples pointers.
  - _Process note (orchestrator): the oracle first cited six section names that do not exist in the template (verified: 0 matches). Direction ACCEPT retained; this evidence line corrected to the file's actual section list, re-checked on disk by the orchestrator._
- **R02 (Lifecycle Rules: Read-Before + Merge-After)**: Proven. `skills/refero-design/SKILL.md` mandates reading existing `DESIGN.md` before generating/refining designs, and merging changes while preserving approved choices instead of blind overwrite.
- **R03 (Hard Rules for Bitmap Media Generation)**: Proven. Stated explicitly as HARD constraints (not advisory) across `skills/refero-design/references/visual-workflow.md`, `skills/design/SKILL.md`, and `skills/banner-design/SKILL.md` (no raster text/digits/logos, generous negative space, stock search before generative AI, one prompt per approved direction).
- **R04 (Templates and Good/Bad Skeletons)**: Proven. Verified `templates/design/DESIGN.md`, `templates/design/examples/good/README.md`, and `templates/design/examples/bad/README.md` are present and integrated into sync manifest (`tools/sync.ps1`) and portability assertions (`tests/test-portability.ps1`).
- **R05 (CONTROL-SURFACE Rule)**: Proven. `agent/AGENTS.md` establishes the CONTROL-SURFACE core law: repeated manual edit (same edit made twice) requires proposing a control surface (script/UI) rather than a third manual pass.

## Verification & Guardrails
- Deterministic Suites:
  - `node --test "tools/tests/*.test.mjs"`: 54/54 passed (0 failures).
  - `python tools/tests/test_session_cost.py`: 7/7 tests passed (0 failures).
  - `verify.ps1 summary`: 26/26 checks passed.
  - `tools/audit.ps1 summary`: 9/9 checks clean.
  - `tests/test-portability.ps1`: 11/11 checks passed.
- Scope Check: `git diff` touches only skills, templates, `agent/AGENTS.md`, and `tests/test-portability.ps1` + `tools/sync.ps1` (sync manifest entry only; no tools logic modified).
