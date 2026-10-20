# Design Contract

This document is the visual contract for the project. It defines tokens, art direction, and reference locks that all design and frontend implementation must follow.

**Precedence:** existing project brand, design system, accessibility, and explicit requirements override any optional taste preset. Fill this contract from the project's real tokens; never replace a working brand with a preset's default palette or font.

<!--
CANONICAL SECTION ORDER:
1. Canvas & tokens
2. Scope (what this contract applies to)
3. Reference lock
4. Imagery strategy
5. Do / Don't
6. Examples pointers
-->

## Canvas & tokens
<!-- Define backgrounds, typography, and accent tokens with explicit roles. Do not use unassigned colors. Inherit from the project's existing tokens; only add tokens that do not exist yet. -->
- **Canvas background**: `[e.g., #0B0F19 (deep navy) / #FAFAF9 (warm off-white)]`
- **Surface / Card**: `[e.g., #111827 / #FFFFFF]`
- **Text primary**: `[e.g., #F9FAFB / #18181B]`
- **Text muted / secondary**: `[e.g., #94A3B8 / #71717A]`
- **Accent primary**: `[e.g., #3B82F6 (blue) / role: primary CTA and interactive focus]`
- **Accent secondary**: `[e.g., #10B981 (emerald) / role: success states only]`
- **Typography font family**: `[inherit project font; e.g., Inter / Geist / system-ui — do not impose a font ban]`
- **Type scale base / ratios**: `[e.g., 16px base, 1.25 scale (Major Third)]`
- **Radius system**: `[e.g., 6px tight / 12px container / pill for tags only]`

## Scope (what this contract applies to)
<!-- Conditional: state which surfaces this contract covers. A small UI tweak needs only the changed component, not a full re-research pass. -->
- **Applies to**: `[e.g., the settings modal and its dialog only]`
- **Task class**: `[small tweak | new component | new page | animation/interaction | landing/conversion | copy-only]`
- **Phases required for this task**: `[e.g., ENGINEERING CRAFT + VISUAL PROOF only]`

## Reference lock
<!-- Commitments established during research. Must lock before implementation begins. Skip when the project already has a reference system. -->
- **Primary reference**: `[URL or product name + what defines its look, or "existing project design system"]`
- **Preserve**: `[Existing project elements, layouts, or branding that must not be broken]`
- **Borrow**: `[Specific patterns to adopt: e.g., hero typography treatment, table row density]`
- **Reject**: `[Patterns explicitly excluded for this project: e.g., no cards with drop shadows]`
- **Media commitments**: `[Specific image treatment, aspect ratios, or video background style]`
- **Token commitments**: `[Strict rules: e.g., zero saturated backgrounds, dark mode only]`

## Imagery strategy
<!-- Guidelines for photography, illustrations, icons, and bitmap media. -->
- **Source preference**: `[Stocks (Pexels / Pixabay / Openverse) > custom generation > bespoke vector]`
- **Visual style**: `[e.g., authentic editorial photography with directional natural light, desaturated 10%]`
- **Composition & overlays**: `[Generous negative space on left/right for text overlay; never bake text into raster]`
- **Icons**: `[e.g., Lucide React, 1.5px stroke, 20px default size, strictly monochrome]`

## Do / Don't
<!-- Concrete, actionable rules for this project. Prefer objective anti-patterns over blanket style bans. -->
### Do
- `[e.g., Use asymmetric bento grids for feature sections]`
- `[e.g., Maintain 64px+ vertical rhythm between major sections]`
- `[e.g., Reuse the project's existing accent hue instead of introducing a new one]`

### Don't
- `[e.g., Never use gradient text on headings or metrics]`
- `[e.g., Never place raster text or logos inside bitmap images; use HTML/vector overlays]`
- `[e.g., Never use centered three-card equal-width pricing grids]`

## Evidence requirements
<!-- A screenshot shows appearance; interactive evidence shows behavior. Match evidence to the task. -->
- **Static appearance**: BEFORE/AFTER screenshots of the changed surface.
- **Flow** (when the task changes a user flow): screenshots of the actual flow (form → submit → result).
- **Keyboard / focus** (when the task touches interactive elements): focus rings and tab order.
- **Responsive** (when the task changes layout): screenshots at multiple viewport sizes.
- **A11y states** (when the task changes states): loading, empty, error, disabled.

## Examples pointers
<!-- Pointers to annotated project reference files in docs/examples. -->
- **Good references (`docs/examples/good/`)**: See `docs/examples/good/` for annotated positive patterns to emulate.
- **Bad references (`docs/examples/bad/`)**: See `docs/examples/bad/` for patterns explicitly rejected in this project.
