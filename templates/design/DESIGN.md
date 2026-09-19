# Design Contract

This document is the visual contract for the project. It defines tokens, art direction, and reference locks that all design and frontend implementation must follow.

<!--
CANONICAL SECTION ORDER:
1. Canvas & tokens
2. Reference lock
3. Imagery strategy
4. Do / Don't
5. Examples pointers
-->

## Canvas & tokens
<!-- Define backgrounds, typography, and accent tokens with explicit roles. Do not use unassigned colors. -->
- **Canvas background**: `[e.g., #0B0F19 (deep navy) / #FAFAF9 (warm off-white)]`
- **Surface / Card**: `[e.g., #111827 / #FFFFFF]`
- **Text primary**: `[e.g., #F9FAFB / #18181B]`
- **Text muted / secondary**: `[e.g., #94A3B8 / #71717A]`
- **Accent primary**: `[e.g., #3B82F6 (blue) / role: primary CTA and interactive focus]`
- **Accent secondary**: `[e.g., #10B981 (emerald) / role: success states only]`
- **Typography font family**: `[e.g., Inter / Geist / system-ui]`
- **Type scale base / ratios**: `[e.g., 16px base, 1.25 scale (Major Third)]`
- **Radius system**: `[e.g., 6px tight / 12px container / pill for tags only]`

## Reference lock
<!-- Commitments established during research. Must lock before implementation begins. -->
- **Primary reference**: `[URL or product name + what defines its look]`
- **Preserve**: `[Existing project elements, layouts, or branding that must not be broken]`
- **Borrow**: `[Specific patterns to adopt: e.g., hero typography treatment, table row density]`
- **Reject**: `[Patterns explicitly excluded: e.g., no cards with drop shadows, no generic hero illustrations]`
- **Media commitments**: `[Specific image treatment, aspect ratios, or video background style]`
- **Token commitments**: `[Strict rules: e.g., zero saturated backgrounds, dark mode only]`

## Imagery strategy
<!-- Guidelines for photography, illustrations, icons, and bitmap media. -->
- **Source preference**: `[Stocks (Pexels / Pixabay / Openverse) > custom generation > bespoke vector]`
- **Visual style**: `[e.g., authentic editorial photography with directional natural light, desaturated 10%]`
- **Composition & overlays**: `[Generous negative space on left/right for text overlay; never bake text into raster]`
- **Icons**: `[e.g., Lucide React, 1.5px stroke, 20px default size, strictly monochrome]`

## Do / Don't
<!-- Concrete, actionable rules for this project. -->
### Do
- `[e.g., Use asymmetric bento grids for feature sections]`
- `[e.g., Maintain 64px+ vertical rhythm between major sections]`
- `[e.g., Always tint neutral backgrounds with 2-3% of the accent hue]`

### Don't
- `[e.g., Never use gradient text on headings or metrics]`
- `[e.g., Never place raster text or logos inside bitmap images; use HTML/vector overlays]`
- `[e.g., Never use centered three-card equal-width pricing grids]`

## Examples pointers
<!-- Pointers to annotated project reference files in docs/examples. -->
- **Good references (`docs/examples/good/`)**: See `docs/examples/good/` for annotated positive patterns to emulate.
- **Bad references (`docs/examples/bad/`)**: See `docs/examples/bad/` for patterns explicitly rejected in this project.
