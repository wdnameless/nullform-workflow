# Recon — workflow risk audit

Current branch: `fix/post-remediation-audit` at `cb5e98f`; clean worktree before this audit. Local installed harness: `D:/ohmypi`, OMP agent directory under the user home. Hindsight recall timed out once; local source and executable checks were used instead. The codebase semantic index returned mostly unrelated skill files with 159 failed embedding batches, so source reads were used.

## Baseline

- `node tools/verify.mjs --profile verify` → `29/29 checks passed`.
- `node tools/verify.mjs --profile audit` → `all 15 checks clean`.
- `node tools/code-size.mjs check --root .` → PASS, `112 files, 729 functions`.
- `node tools/sync.mjs --check --quiet` against installed harness → `sync: clean (60 files checked, skills parity verified)`.
- Prior CI run was green; it is not evidence for inputs absent from the test matrix.

## Independent read-only scopes

`InstallSyncAudit-2`: PowerShell/Node installers, sync/promote/manifest. `GateCIAudit`: tier enforcement, CI and acceptance. `DashboardSecurityAudit`: local HTTP/dashboard identity and filesystem boundaries. No agents edited or ran full suites. Parent re-read source and reprobed high-impact claims.

## Disposable runtime probes (all fixtures cleaned)

- **PowerShell install:** a fake `GITHUB_PERSONAL_ACCESS_TOKEN` kept the GitHub MCP entry; generated env still equalled literal `__GITHUB_PAT__`; installer exited 0. No real credential used.
- **Sync promote:** fixture with `--harness . --promote --force` and `agent/AGENTS.md` text `workflow.mjs ... 1.2` exited 0 and wrote `workflow<HARNESS>mjs ... 1<HARNESS>2` into the repo fixture.
- **Sync rule drift:** `--deploy` updated only agents-home rule; live harness and OMP agent rule remained OLD. `--check` reported `sync: clean (1 files checked)`.
- **Node OMP install:** exited 0 into isolated home/root, but `home/.omp/agent/rules/enterprise-directives.md` was absent; `home/.agents/rules/enterprise-directives.md` existed, and seeded Chrome DevTools MCP command was `cmd.exe`.
- **Nested target:** an isolated minimal repo installing into its own `tools/nested` did not finish in 3 seconds; copy recursion entered the newly created destination under the source. Throwaway tree removed.
- **Dashboard --session:** `--ensure --session alpha` exited 0 but `--list` showed only runtime key `local`.
- **Dashboard session adoption:** two requests for `alpha` and `beta` on the same free dynamic port produced distinct runtime keys pointing to the *same PID/port*, second response `adopted: true`.
- **Dashboard path escape:** `writeRuntime(project, {key:'../../../unrelated',…})` overwrote `unrelated.json` outside project root. Exception from the second legacy-runtime write did not undo the first overwrite.
- **Guarded auto:** T0 started with `--allow src/** --max-diff 1`, wrote a 12-line `outside.txt`, then `close` without `--diff-lines` returned 0.
- **CI tier:** current branch differs from origin/master by 87 files; `check-ci --tier T1 --base-ref origin/master` returned 0. `--tier T3 --change symlink-entry-guard` accepted T2 evidence.
- **Local vs CI T2:** minimal isolated T2 task with recon/manifest/interfaces/openspec/oracle detail had `check` and `close` exit 0, despite no proposal/tasks/specs/oracle.md; `check-ci` rejected missing proposal.
- **Git errors:** in an isolated git repo on Windows, `execFileSync('git', ['log','-1','--format=%H',…])` failed with `ERR_INVALID_ARG_VALUE` because a PATH-leading git.bat cannot safely receive `%H`; `check-ci` swallowed the error and reported T2 evidence verified despite an unrelated commit after oracle.
- **PR merge freshness:** with git.exe first on PATH, a clean merge commit containing an unrelated target-branch update yielded `workflow check-ci: files modified in commits after oracle acceptance … upstream.txt` (exit 1).
- **Multiple oracle verdicts:** independent oracle fixture contained `oracle-1.md` ACCEPT and `oracle-2.md` REJECT; `check-ci --tier T2` returned 0 because it stops at the first matching file.
- **Tracked credential-named code:** independent oracle changed `src/credentials.ts` after recording ACCEPT; local T2 `close` still returned 0 because the snapshot excludes basenames matching `credentials`.
- **Installed baseline omission:** independent oracle's Node-installer sandbox reported sync drift on `.code-size.baseline.json`; the installer does not copy this manifest-listed file.

No real user configuration, repo code, credentials, or live services were mutated. Baseline checks alone cannot detect these cases.
