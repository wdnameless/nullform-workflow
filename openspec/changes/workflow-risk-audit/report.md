# Audit report — current workflow harness

**Verdict:** Normal-path checks are green (`verify` 29/29, `audit` 15/15, size PASS, sync clean), but several consumer-visible paths remain broken. Findings below were source-checked and, where practical, reproduced in disposable fixtures. No code was changed by this audit.

## Must fix

### 1. `sync --promote --harness .` corrupts prompt source text (data integrity)
**Location:** `tools/sync.mjs:205,284-294`. `harnessRoot` keeps the caller's relative `.`. In promote, `replaceAll(slashHarness, '<HARNESS>')` then replaces *every period*, not just a root path. **Observed:** isolated promote exited 0 and wrote `workflow<HARNESS>mjs … 1<HARNESS>2` into repo `agent/AGENTS.md`, replacing valid text. A `--force` invocation is allowed and bypasses only the mtime guard, not this bug. Resolve/validate the root before substitution and anchor the replacement to actual root paths.

### 2. Dashboard session key can overwrite files outside the project
**Location:** `tools/dashboard.mjs:765-769,2125-2129,2161-2179,2890-2900`. `--session` is returned raw by `sessionKey`; `runtimePath` appends `<key>.json` with `join` and `writeRuntime` writes it without realpath containment. **Observed:** `writeRuntime(project,{key:'../../../unrelated',…})` overwrote `unrelated.json` outside `project`. The subsequent failed legacy-runtime write did not roll that back. The exposed input is a local CLI flag, **not** an HTTP parameter; the risk is data loss by automation or a careless caller, not remote privilege escalation. Reject path separators/`..` or enforce containment before any write.

### 3. Tier CI and guarded-auto controls can be bypassed
**Location:** `tools/workflow.mjs:1395-1399,521-562,1242-1251`; `.github/workflows/repo-gate.yml:110-192`. A PR with a `workflow:T1` label unconditionally passes `check-ci` without recon evidence or a file ceiling, contrary to `openspec/changes/harness-simplification/specs/ci-tier-gate/spec.md:11-24`. **Observed:** the current 87-file PR passed `check-ci --tier T1`; T3 likewise accepted a T2 change without worktree evidence (`workflow.mjs:62-64,1401-1544`). Locally, T0 `--auto --allow src/** --max-diff 1`, a 12-line `outside.txt`, and `close` **without** `--diff-lines` returned 0. No allowed-path match is checked and the size guard runs only when the caller volunteers a number. These are policy gates with caller-controlled green results.

### 4. Acceptance checks miss rejected or changed code
**Location:** `tools/workflow.mjs:678-712,1111-1181,1482-1502,1504-1541`. CI reads the *first* `oracle*.md` and stops: the independent oracle reproduced `oracle-1.md` with ACCEPT + `oracle-2.md` with REJECT yielding `check-ci` exit 0, violating the required double acceptance. The local worktree snapshot excludes any basename matching `credentials` or beginning `secrets` to avoid reading sensitive data, but this also excludes tracked source code. **Observed by the independent oracle:** editing tracked `src/credentials.ts` after ACCEPT still allowed `close` exit 0. Separately, CI silently catches git status/log/diff errors; on Windows, a PATH-leading `git.bat` rejected Node's `--format=%H` with `ERR_INVALID_ARG_VALUE`, yet an unrelated commit after the oracle still produced `workflow check-ci: T2 evidence verified` (exit 0). Preserve secret-content confidentiality while detecting tracked changes, require the actual verdict set, and fail closed when git evidence cannot be obtained.

### 5. Portable OMP installation succeeds but leaves the harness unusable
**Location:** `tools/install-harness.mjs:371-395,484-524`; `agent/mcp.json.example:6-43`; `tools/doctor.mjs:808-811`; `tools/sync-manifest.json:177-179`. The Node installer copies rules to `~/.agents/rules` but not `~/.omp/agent/rules`, unlike `install.ps1:269-274`. **Observed:** isolated OMP install exited 0; the required OMP agent rule was absent while the agents-home rule existed. The seeded Chrome DevTools MCP uses Windows-only `cmd.exe`, which cannot launch on Linux/macOS. It also omits `.code-size.baseline.json` from core files even though sync requires that file; a second oracle's sandbox `sync --check` failed on the missing baseline. The OS matrix checks file presence/JSON but not installed-mode doctor wiring, MCP process startup, or sync parity. Make the installation contract executable on each platform.

### 6. PowerShell installer reports success with an unusable configured GitHub MCP
**Location:** `install.ps1:156-169,319-340`; `agent/mcp.json.example:45-51`. A supplied `GITHUB_PERSONAL_ACCESS_TOKEN` keeps the GitHub server, but `Patch` has no mapping for `__GITHUB_PAT__`. **Observed:** isolated install with a dummy canary exited 0 and wrote the GitHub MCP env value as the literal placeholder, not the canary. No real key was printed or used. The analogous `POSTGRES_URL` branch keeps a hardcoded sample connection URL (`mcp.json.example:53-57`); this part is source evidence, not separately reproduced. Generate usable values or reject incomplete configuration.

## Should fix

### 7. Sync reports `clean` while the active enterprise directive is stale
**Location:** `tools/sync-manifest.json:29-31`; `tools/sync.mjs:238-260`; `install.ps1:269-274`. Manifest has one rule target, `@agents`, while the installer creates additional copies under harness `rules/` and OMP agent `rules/`. **Observed:** `--deploy` updated only the agents-home rule; harness and OMP agent copies remained OLD, and `--check` exited 0 with `sync: clean (1 files checked)`. The active `rule://enterprise-directives` can therefore stay outdated despite green drift checks.

### 8. Installing under source `tools/` recursively copies into itself
**Location:** `tools/install-harness.mjs:338-382,192-222`. `--root` is unrestricted. If the destination is inside a copied source directory, the earlier `agent` copy creates the destination, then the `tools` walk discovers its own nested destination and descends recursively. **Observed:** a minimal isolated repo with `--root <repo>/tools/nested` did not finish in 3 seconds and was terminated; the fixture was cleaned. This is a user-triggered disk/time exhaustion, not the documented in-place `--root .` path. Refuse a destination nested inside a source subtree.

### 9. Dashboard session selection crosses boundaries
**Location:** `tools/dashboard.mjs:83-90,2589-2592,2682-2716,2855-2867`. `--ensure` and `--url` omit parsed `opts.session`; **observed** `--ensure --session alpha` created runtime key `local`. Health compatibility checks project/build/protocol but not the server's session; **observed** requesting `alpha` then `beta` on the same dynamically allocated port returned the same PID/port, the second `adopted:true`. HTTP state is collected using the first process's `SERVER_SESSION`, so distinct agents can see each other's dashboard state. No raw patch disclosure or DNS-rebinding bypass was found: Host checks and HTTP sanitization are effective.

### 10. Local and CI evidence contracts disagree; PR merge creates false staleness
**Location:** `tools/workflow.mjs:56-60,1420-1499,1520-1535`. **Observed:** isolated T2 `check` and `close` exited 0 with recon, manifest, interfaces, an OpenSpec directory and ACCEPT detail, but no proposal, tasks, specs or `oracle.md`; `check-ci` rejected it. With real `git.exe`, a clean PR merge commit containing an unrelated target-branch update was rejected as a post-oracle edit. Define the same required evidence locally and in CI, and compare acceptance with the PR head/ref rather than unrelated merge-parent changes.

## What holds

Sync promote pre-scans every suspect mtime before mutation (`tools/sync.mjs:238-299`); the configured happy-path installation/health checks are green; dashboard Host validation rejects non-loopback names and sanitized HTTP state does not expose raw git patches. The five-job OS CI matrix exercises install and PowerShell paths. Those strengths do not cover the failing inputs above.

## Limits and next decision

This is a read-only, risk-prioritized audit of installer/sync, tier/CI, and dashboard boundaries — not a proof of every tool or upstream MCP service. No production secrets, active user files, or project code were modified. Fix the destructive sync substitution and dashboard file containment first; then strengthen tier gates and portable install contracts. The report does **not** claim remote network exploitation of the local dashboard or exhaustive security coverage.
