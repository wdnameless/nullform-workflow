# Oracle verdict — universal-1

Blind acceptance audit vs `manifest.md` (R01–R09) and the running code on branch
`feat/universal-1`. Planning docs not opened. Full evidence in oracle transcript.

| ID | Verdict | Evidence |
|---|---|---|
| R01 | proven | `tools/install-detect.mjs:124` detectInstall (VERSION, .harness-root, state); u-install pass (v1.2.0 vs v1.3.0) |
| R02 | proven | `tools/install-detect.mjs:97` suggestUpgrade (`nullform update`); u-install pass (cur < latest) |
| R03 | proven | `tools/install-detect.mjs:18` detectConflicts (.autopilot, skills, CLAUDE.md); u-install pass; never deletes |
| R04 | proven | `tools/doctor-lite.mjs:26` doctorLite; workflow.mjs:608,1044 warn-only hooks; `doctor.mjs` → pass=9 fail=0 warn=4 skip=3 → OK |
| R05 | proven | `tools/brief-rounds.mjs:65` runBriefRounds, `:132` appendAddenda; workflow.mjs cmdBrief; u-brief 7/7 |
| R06 | proven | `tools/dashboard.mjs` collectWaves; live `/api/state` run.waves + run.calibration (targetLines 3000); u-waves 12/12 |
| R07 | proven | `tools/benchmark-run.mjs:131` runBenchmark; docs/benchmark.md; Total Units 33450, 16 tests, 9900ms, 0 network/paid |
| R08 | proven | `skills/nullform/SKILL.md` Briefing→Build→Review, npx skills add; skills-doctor 0 problems VERIFIED |
| R09 | proven | `tools/workflow.mjs:1784` checkQualityGates (size/debt/hygiene/orphan); u-quality 9/9 |

Prohibitions: detectConflicts never deletes (test: .autopilot/ap.py untouched);
doctorLite warn-only, exit unchanged (cmdStart/cmdCheck return 0);
benchmark 0 network/paid calls.

Gates: u-* 43/43 + dashboard 38/38 green; `code-size: PASS (238 files, 1555 fns)`;
`doctor: OK`. Known pre-existing: quality-evidence live-ledger drift (35 vs 18
settled, env dirt, fails at base too when ledger present — not a regression);
unused imports/portB in dashboard.test.mjs pre-date this change.

Concerns closed: code-size baseline refreshed (sanitizeHttpState 394, main 138,
cmdStart 148; dashboard/test defer markers; phantom esc allow with scanner-debt
note — code-size `${}` masking bug); own 4 slice worktrees removed after merge.

Verdict: ACCEPT
