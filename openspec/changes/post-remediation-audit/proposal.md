# Post-remediation audit fixes

## Why

The first cleanup introduced defects into the new sync engine and the code-size gate.
A refused promote could partially mutate the repo, a missing OMP law file could read as
clean, and the size gate could misclassify method bodies and text inside templates.

## What changes

- Fail safely before promote writes; detect and repair the missing runtime law copy.
- Keep explicit roots and JSON output truthful, and ship the sync engine with its shims.
- Measure multiline methods without treating comments or template text as code;
  make baseline generation deterministic.
- Return only a dashboard URL verified by the dashboard's own HTTP health probe.
- Bring role instructions and the doctor inventory into line with the actual tools.

## Out of scope

No new dependencies, new public CLI flags, module split or unrelated refactor.
