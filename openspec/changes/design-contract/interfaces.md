# Interfaces and ownership — design-contract

## Convention: DESIGN.md (consumer: refero-design skill)
- Location: `<project>/docs/DESIGN.md`. Optional; skill MUST work when absent (skip silently, note in one line).
- When present: read at the START of any design task, before reference research. The file is the project's visual contract: canvas/type/accent tokens with roles, reference lock (primary direction + preserve/borrow/reject), imagery strategy, do/don't.
- After research + lock: UPDATE the file — merge, never blind-overwrite. Sections not touched this session stay byte-identical. Template `templates/design/DESIGN.md` defines canonical section order so merges are deterministic.
- Ownership: skill instructs; no code tool enforces (advisory convention, quality-first — no blocking gates on user projects).

## Convention: examples folders
- `docs/examples/good/`, `docs/examples/bad/` — short annotated samples.
- refero-design references them in research and QA steps; when examples conflict with the lock, the lock wins and the conflict is reported.

## Hard media rules (consumer: refero-design/references/visual-workflow.md, design, banner-design)
- Mark section «ЖЁСТКИЕ ПРАВИЛА» / HARD RULES. Applies when generating bitmap media:
  1. No text, digits, logos in raster output — text is always a vector/HTML overlay.
  2. Leave generous negative space where overlays will land.
  3. Stocks (Pexels/Pixabay/Openverse) BEFORE generation when a stock answer exists.
  4. One generation prompt per approved art direction; no shotgun variations.

## AGENTS.md rule (consumer: all agents)
One line pair in the laws section: repeated manual edit → propose a control surface (script/UI) instead of a third manual pass.

## Ownership
- **Designer (single writer)**: skills/refero-design/SKILL.md + its references (visual-workflow.md), skills/design/SKILL.md + references touched for media rules, templates/design/** (new), agent/AGENTS.md (one insertion).
- **Main**: specs, sync.ps1 manifest additions (templates/design/**), prompt-lint baseline refresh, integration, git.
- Disjoint: designer never edits tools/**, verify.ps1, sync.ps1.
- Skip: running verify/tests while designer works (parent runs after integration).
