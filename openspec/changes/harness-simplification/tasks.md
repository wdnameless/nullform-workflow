# Delivery tasks

Ordered by risk: correctness first, deletion second, restructuring **last** and only as far
as the standard library leaves anything to restructure. Each task ends with the same
invariant: `node tools/verify.mjs --profile verify` → 29/29, `--profile audit` → 14/14,
`node --test tools/tests/*.test.mjs` → 366 pass, `node tools/auto-review.mjs --root .` → exit 0.
No step starts before the user picks it.

## Phase 1 — the confirmed defects — DONE (commit ffa1c38)

Completed: R02, R02b, R03, R04, R05, R06, R07, R08, R08a, R08b, R08c, R14, R17, R18, R19, R20,
R21, R22, R23. Verified: 366/366 tests, verify 29/29, audit 14/14, sync clean on the real trees.
The items remain below as the record of what was done.

- [ ] R02 Reverse `<HARNESS>` on promote in `tools/sync.ps1:195` and `tools/sync.sh:227`;
      add the machine-path pattern to `tools/prompt-lint.mjs` so a contaminated template
      fails CI rather than review.
- [ ] R03 Add the OMP copy to drift coverage (manifest entry or link) and a verify check that
      compares `~/.omp/agent/AGENTS.md` with `agent/AGENTS.md`.
- [ ] R04 `agent/agents/oracle.md:4` — add `bash`.
- [ ] R05 `agent/agents/designer.md:26` — gate isolation on "session cwd is a git repository".
- [ ] R06 `tools/workflow.mjs:1294` — `deviation.missing = [...missing]`.
- [ ] R07 `tools/verify.mjs` — audit check 5 fails (not passes) on exit 2; checks 4/10 report
      not-configured when their subject is absent; audit check 10 `ok: n === 0`.
- [ ] R08 Lane TTL — `start` reports and offers to release a lane older than a window; the
      state records the owning session.
- [ ] R08a `workflow.mjs:963-968` — `mustContain` is applied to `--detail` for every kind; a
      valid `manifest` submission is rejected with an oracle-specific message. Reproduced.
- [ ] R08b Shard the suite or add per-test timeouts; the 6–66 s doctor/orphan tests are the target.
- [ ] R08c `dashboard.mjs:2161-2172 writeRuntime` — atomic tmp+rename (the pattern is already in
      `workflow.mjs:118-126`); the file is polled and parsed every 80 ms.
- [ ] R17 `workflow.mjs:969` — stop testing `--detail` against the manifest *file* pattern;
      scope `mustContain` to the file body only.
- [ ] R18 `verify.mjs:865-881` — parse the CI template or rename the check to what it does.
- [ ] R19 `sync-prune.mjs:127` — assert candidate containment inside the harness root before `rmSync`.
- [ ] R20 `sync-prune.mjs:195-207` — return nonzero when any deletion failed.
- [ ] R21 `benchmark.mjs:1612`, `usage-audit.mjs:654` — add the `process.argv[1] &&` guard the other
      tools already have.
- [ ] R22 `agent/agents/librarian.md` — grant `bash` or rewrite lines 91/92/110 to a tool it has;
      move the scratch path to `os.tmpdir()` per `AGENTS.md:32`.
- [ ] R23 `tools/context-inbox.mjs` — implement `--note` or drop it from the usage text.
- [x] R08d **DONE** — prune now uses an allow-list (`SHIPPED_SUFFIX` + `RUNTIME_NAMES`)
      instead of a suffix deny-list; the real trees report 0 candidates, a planted orphan is
      still caught, and doctor's `orphan-files` check passes. Originally deferred, then made
      blocking by merge acceptance.
- [ ] (deferred) Separate runtime state from the distributed tree, or teach prune that `agent/*.db`,
      device ids and version stamps are runtime, not orphans (`tools/sync-prune.mjs:50` already
      has a `NEVER_SUFFIX` list — these files do not match it).

## Phase 2 — deletion before abstraction (R11)

Deleting first is what makes Phase 3 small. A file that loses 200 lines of unused export
surface is easier to split, and may no longer need splitting.

- [ ] Drop the unused export surface: `install-harness.mjs` (11 exports, all unused),
      `verify.mjs` (16 exports, 1 used), `workflow.mjs:1540` (2 of 20 unused).
- [ ] Delete `dashboard.mjs:2737 refreshDashboardFile` or call it from `main`.
- [ ] Delete one of the two byte-identical return-contract fixtures.
- [ ] Replace the source-text assertions (`dashboard.test.mjs:335`,
      `install-harness.test.mjs:344`, `workflow-gate.test.mjs:233`, `bash-gates.test.mjs:65`,
      `workflow-metrics.test.mjs:28`) with behavioural ones.
- [ ] Hoist `createTempDir` (9 copies) into one test helper.

## Phase 3 — use the runtime, delete the duplication (R09) — DONE

Outcome after migration (verified on the tree, 366/366 tests green):

- **14 tools** now call `fs.readdirSync(root, { recursive: true })`, up from 0.
- **8 tools** migrated argv parsing to `node:util.parseArgs`
  (`cache-doctor`, `cache-policy`, `oracle-model`, `return-contract`, `skills-doctor`,
  `sync-prune`, plus the two walker migrations). Net line change across the migrated files
  was **−24 lines**.
- **6 walkers deliberately keep their own loop** — `sync-prune`, `debt-ledger`,
  `gherkin-spec`, `glossary` prune during descent (`node_modules`, `.git`, dot-dirs,
  `SKIP_DIRS`/`IGNORE` sets), which the standard library cannot express; `auto-review` and
  `skills-doctor` do single-level scans, not walks. Each is a recorded exception, not a miss.
- **Zero shared modules created.** No `tools/lib/` — the two prior drafts (seven modules, then
  three) were rejected and the final answer is deletion against the runtime.

The critical contract was preserved throughout: `node tools/debt-ledger.mjs scan --check
--markr TODO` still exits 2 with `неизвестный флаг --markr` on stderr, because the
hand-rolled parsers consume an unknown flag's value and `parseArgs` does not.

## Phase 4 — split only what is still too big (R10) — assessed, currently NOT worth doing

Measured against the "net line count must not rise" invariant and the user's minimalism
criterion, both candidate splits fail the cost/benefit test right now:

| Candidate | Measurement | Judgement |
|---|---|---|
| `dashboard.mjs` `generateDashboardHtml` | 861 lines, a **pure function** `data -> html`, 3 internal callers, covered by ~8 tests in `dashboard.test.mjs`, with 49 nested helper functions and ~104 lines of markup in one template literal | A genuine seam exists, but extraction is pure rearrangement: same total lines, one more file, one more import. **Defer** until the file actually blocks a change. |
| `doctor.mjs` `runDoctor` | one **flat sequence of 53 `checks.push` calls**, zero nested functions — an agent can grep and edit it directly | A dynamic check registry would scatter those 53 checks across files and make the failure path harder to follow. Blind acceptance named this the step most likely to harm agent-navigability. **Do not split.** |

Both are recorded as deliberate non-actions with the measurement that justifies them, rather
than performed to make the plan look complete. Revisit only if a real change is blocked by the
file's size.

## Phase 5 — one program per job (R13)

Branch convergence (R12) is **DONE**: master fast-forwarded 52 commits past `406ffce`, nine
absorbed branches deleted (all verified with `git cherry` — zero unabsorbed commits), 15 stale
worktrees pruned. Branch count 24 -> 3.

- [ ] Replace `sync.ps1` (313) + `sync.sh` (414) with one `tools/sync.mjs` reading a single
      manifest file; keep thin per-OS shims, the way `install.sh` already is one.
- [ ] Fold plugin install, provider config and the doctor run into `tools/install-harness.mjs`
      so POSIX installs get them; `install.ps1` becomes a Windows shim.
- [ ] Close the gate holes: a typo must exit 2; T1 CI must require its recon evidence; the
      printed request budget must be checked or removed from the law.
- [ ] Converge the branches onto one line in a stated order, starting with the four
      conflicting pairs. Bring `master` current.

## Phase 6 — make the docs true (R15)

- [ ] Fix `CONTEXT.md` (`bench/tasks.json`, `.prompt-lint/budget.json`, the truncated
      *Session reuse* entry) and document the 10 missing tools.
- [ ] Reconcile the README's "0 external npm packages" with the 23 MB vendored `typescript`
      (referenced by nothing in the tree).
- [ ] Decide the fate of the 18 unreferenced skills and the 12 skills over 400 lines.
