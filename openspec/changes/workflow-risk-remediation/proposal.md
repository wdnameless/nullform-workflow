# Proposal — repair the workflow's uncovered boundaries

Normal-path tests and health gates pass, but the audit found cases where the harness corrupts prompts, leaves an install incomplete, accepts insufficient review evidence, or writes outside a project. This change closes those cases without replacing working components or weakening intentional fail-closed checks.

Four end-to-end slices cover sync, tier/CI, local dashboard and installation. The library refresh is limited to dependencies that the repository declares; it does not silently change machine-wide OMP plugins, API credentials or unrelated agent integrations. Each slice has an executable regression, and the final installed harness and cross-OS CI must work before the branch is pushed.
