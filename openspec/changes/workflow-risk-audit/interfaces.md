# Audit boundaries and interfaces

Read-only audit; no public signature, API, schema, or agent prompt is changed.

| Boundary | Consumer-facing contract | Owner/read scope |
|---|---|---|
| `install.ps1`, `tools/install-harness.mjs` | Install the same usable OMP harness and preserve operator config | installation/agent wiring |
| `tools/sync.mjs` + `sync-manifest.json` | Detect drift and promote/deploy without losing source text or stale active copies | repo/live/agent trees |
| `tools/workflow.mjs` + `.github/workflows/repo-gate.yml` | Enforce claimed tier, allowed paths, and fresh acceptance in local and PR contexts | workflow state and CI |
| `tools/dashboard.mjs` | Keep per-session dashboard identity and filesystem writes within project scope | local server/runtime |
| `tools/verify.mjs`, `tools/doctor.mjs` | Report broken installation as FAIL; no false success | observed health |

Testing seam: throwaway fixture directories in `os.tmpdir()` with fake repo/harness roots. No production config, active server or user data is modified. Findings are checked against current source and runtime output; no fixes in this lane.
