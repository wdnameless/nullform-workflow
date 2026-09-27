# Delivery tasks

- [x] R30–R35: sync preflight, law-copy restoration, root validation, clean JSON,
  token mapping, engine/manifest self-shipping. Sandbox and regression tests.
- [x] R36–R38: multiline method measurement, comment/template masking, deterministic
  baseline. Targeted regression tests.
- [x] R39: dashboard startup delegates liveness to `dashboard.mjs --ensure`,
  with a real CLI + HTTP health regression.
- [x] R40: protect only host config in `agent/`; keep new template/tool configs
  visible to prune, covered by the existing prune candidate test.
- [x] R41–R42: align dashboard role guidance and name the runnable replay command.
- [x] Doctor inventory: fail when the installed sync engine/manifest are absent.
- [x] Confirm full suite, verify/audit, size gate, OpenSpec validation, live deploy.
- [x] Independent blind acceptance on the final tree, then close the T2 lane.
