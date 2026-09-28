# Interfaces and ownership

No public CLI flag, export signature, or HTTP response shape changes. Reuse the existing Node stdlib and test fixtures; no extra dependency or compatibility shim. One writer owns each source/test pair.

| Consumer seam | Invariant and signature | Owner and paths | Requirements |
|---|---|---|---|
| `node tools/sync.mjs --check/--deploy/--promote` + `tools/verify.mjs --profile verify|audit --user-home <dir>` | Manifest sources and destinations stay inside their declared canonical roots before I/O; promote templating replaces a root at end-of-line; verify passes the sandbox `.omp/agent` root to sync on both OS paths. Exit nonzero on unsafe paths without partial writes. | Sync worktree: `tools/sync.mjs`, `tools/verify.mjs`, `tools/tests/sync.test.mjs`, `tools/tests/install-harness.test.mjs` only. | R01–R03 |
| `cmdCheck(root)`, `cmdClose(root, flags)`, `cmdCheckCi(root, flags)` | All matching oracle evidence in the registered change counts; an explicit positive `--path` outside it cannot satisfy acceptance and any sibling REJECT blocks. Guarded auto cannot skip measurement when Git fails in a Git repository. | Workflow worktree: `tools/workflow.mjs`, `tools/tests/workflow-gate.test.mjs`, `tools/tests/workflow-suggest.test.mjs` only. | R04–R05 |
| `generateDashboardHtml(data)`, `main(argv)`, `/api/diff?file=...`, `sanitizeHttpState(data)` | Static snapshot uses existing HTTP-safe projection; diff metadata count is independent of untracked file size in memory and never includes raw content. | Dashboard worktree: `tools/dashboard.mjs`, `tools/tests/dashboard.test.mjs`, `skills/cro/cro/SKILL.md` deletion only. | R06–R08 |
| Written recommendation, not a new runtime seam | Compare video/Claude Academy `intent.md` against current Wave 0, manifest and OpenSpec; no extra compulsory artifact or prompt-template edit. | Parent: this OpenSpec change and final report. | R09 |

All worktrees are isolated under the OS temp area by `task(... isolated:true)` in this Git checkout. Writers skip build/lint/tests/formatters mid-flight; parent runs all checks after integration. Existing untracked `backups/` remains untouched.
