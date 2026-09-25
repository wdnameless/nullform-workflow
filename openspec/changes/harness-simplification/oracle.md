# Oracle record — harness audit

The tier gate resolves the oracle model to `nullform-gateway/gemini-3.8-flash-high`
(`node tools/oracle-model.mjs ensure --probe`), which is **flash-class**. Per the double
acceptance rule a single pass is not acceptance: every verdict below was produced by two
independent passes, and the rule requires the two to agree.

## Round 1 — pair one (ACCEPT + REJECT → fix round required)

| Pass | Agent | Verdict | Gates |
|---|---|---|---|
| A | `BlindOracleA` | **ACCEPT** | evidence_soundness, user_request_coverage, plan_verifiability, seam_check, deep_module_quality, vocabulary_drift, adr_conflict — all true |
| B | `BlindOracleB` | **REJECT** | audit_accuracy **true**; minimalism_compliance **false**; agent_human_comprehensibility **false**; security_coverage **false** |

The pair disagreed, so the rule forced a fix round.

### Pass B's objection (upheld)

The plan invented **seven** new `tools/lib/*.mjs` modules for problems the Node runtime
already solves. The user asked for minimalism; seven new modules is its opposite. The author
verified the runtime first and **accepted the objection**:

- `node:util.parseArgs` — confirmed on this host parsing
  `--tier T2 --force --task "audit work"` → `{tier:'T2', force:true, task:'audit work'}`.
- `fs.readdirSync(root, { recursive: true })` — confirmed returning the whole tree.

Seven modules → **one**.

### Pass B's other gates, adjudicated

- `agent_human_comprehensibility = false` — **upheld in part**. The original Phase 3 split
  `workflow.mjs`, `verify.mjs` and `benchmark.mjs` on the assumption that smaller is always
  clearer. A 1 242-line module cut into three 400-line ones fragments context for an agent
  navigating by symbol. Phase 4 now reads "re-measure; split only if still >800 lines after
  the deletions, and only where each part has one reason to change".
- `security_coverage = false` — **upheld**. The plan had no security step. Now covered by
  R19 (containment before `rmSync`) and R02 (machine paths in templates), both from the
  oracle rounds themselves.

### Pass B's claims that did NOT survive verification

| Claim | Test | Result |
|---|---|---|
| `tools/workflow.mjs save()` is non-atomic | read `workflow.mjs:118-126` | **REFUTED** — unique temp file + `renameSync`. |
| `tools/dashboard.mjs:2589-2590` `/api/diff` allows traversal reads | started the real server on port 24777, fetched 3 traversal shapes | **REFUTED** — no content leaked; `git status --porcelain -- <outside>` exits 128. |
| Remove the 23 MB vendored `typescript` | `grep -rl node_modules/typescript` over the tree | **NOT ACTIONABLE as stated** — nothing references it, but removal is a user decision, so it is reported (R15) rather than planned. |

### Pass A's additional defects (all verified before acceptance)

Four were confirmed and added: R17 (`workflow.mjs:969` tests `--detail` against the manifest
*file* pattern — reproduced, a valid manifest submission is rejected with an
oracle-specific message), R18 (`verify.mjs:865` labelled "parses as YAML", runs five regexes),
R19 (`sync-prune.mjs:127` no containment check), R08c (`dashboard.mjs:2161` `writeRuntime`
non-atomic while polled every 80 ms). Two were refuted (check 13 parse-error branch returns
`ok:false`; the traversal claim).

### Fix round applied

`tasks.md` and `interfaces.md` rewritten: **deletion before abstraction**; the standard
library before any helper; a `net line count must not rise` invariant; Phase 4 cut back to
the two splits with measured cause. Manifest R09 and R16 rewritten to state the measured
duplication counts instead of estimates.

## Round 2 — pair two (fresh pair, run after the fix round)

| Pass | Agent | Verdict |
|---|---|---|
| A | `PairTwoA` | **REJECT** |
| B | `PairTwoB` | **ACCEPT** (of superseded text) |

### Pair two, pass A' objection (upheld — and it improved the plan)

The first fix round over-corrected: it replaced the seven modules with *bare* stdlib calls.
Pass A tested both replacements and found each wrong. The author reproduced both findings
before accepting them:

| Objection | Test run | Result |
|---|---|---|
| `node:util.parseArgs` cannot replace the hand-rolled parsers | `parseArgs({options:{runs:{type:'number'}}})` | **CONFIRMED** — throws `TypeError`. Also `ERR_PARSE_ARGS_UNKNOWN_OPTION` on an unknown flag, while **12** tools collect unknown flags into `errors[]` (`debt-ledger.mjs:461`, `dashboard.mjs:2766`, `context-inbox.mjs:503`) and `benchmark.test.mjs:768` asserts a numeric flag. |
| `fs.readdirSync({recursive:true})` cannot replace the walkers | counted entries under `tools/` | **CONFIRMED** — 233 entries returned, **157 of them inside `node_modules`**; no descent predicate exists, so the pruning the 17 walkers perform cannot be expressed. |

Both objections were accepted. Phase 3 now lands **three** modules for **42 call sites**
(`args`, `fs`, `json-state`), each required to justify itself by the measured stdlib gap.
Pass A recorded `minimalism_compliance: true` for the revised shape and `defects_verified: true`
for all four new defects (R17, R18, R19, R08c) — every one reproduced independently.

### Round 3 — pair three (current text)

| Pass | Agent | Verdict |
|---|---|---|
| A | `Round3A` | **REJECT** |
| B | `Round3B` | **ACCEPT** |

Pass A challenged the *third* draft's three modules and won on all three, with measurements the
author reproduced:

| Module | Pass A's measurement | Reproduced by the author | Outcome |
|---|---|---|---|
| `args.mjs` | only 3 test files inspect `errors[]` | confirmed — `gherkin-spec`, `mutation-test`, `dashboard` | **dropped** |
| `fs.mjs` | the `node_modules` crawl is trivial | confirmed — 233 entries in **7–13 ms**, filter under 1 ms (pass A said <3 ms; measured higher, conclusion unchanged) | **dropped** |
| `json-state.mjs` | 0 of the target writers have concurrent readers | **partly confirmed** — the real writer count is **7**, not the 23 the author had claimed (a bad grep matching every `JSON.stringify`), and 2 are concurrent, one already atomic | **dropped** |

Phase 3 now creates **no shared modules**; the third draft's plan was wrong in the same
direction twice (first too many modules, then too few deletions).

### Round 3 pass B — ACCEPT with corrections

Pass B's gates all passed (`actionability`, `uncertainty_honesty`, `law_compliance`,
`deep_module`, `vocabulary_drift`) and it confirmed three of the refutation rows by independent
re-read. It also corrected the author on two points, both **upheld after verification**:

1. **R07's glossary sub-claim was wrong.** `glossary.mjs:220` exits 2 when `CONTEXT.md` is absent,
   and `AGENTS.md:79-80` plus `oracle.md:38` state a missing glossary must be *reported, never
   failed* ("If `CONTEXT.md` does not exist, do not fail for its absence"). Passing on exit 2 is
   the intended protocol; the sub-claim was removed from R07.
2. **R19 is latent, not active.** `findPruneCandidates` crawls only `MANIFEST_DIRS` inside the
   harness root and no CLI flag supplies arbitrary paths. The row already said "latent"; it stays
   as a defensive item, not a defect.

Pass B also returned two genuine defects the audit had missed, both verified and added:

- **R22** — `agent/agents/librarian.md:5-12` omits `bash` while lines 91/92/110 require
  `git clone`, `git checkout` and `rm -rf`; the `/tmp/` scratch path also breaks the
  workspace-containment rule at `AGENTS.md:32`. Same class as R04.
- **R23** — `tools/context-inbox.mjs:499` documents `--note`, which `FLAG_SPEC` (`:481-491`)
  does not define.

### Result of round 3

One REJECT (which produced a strictly better plan) and one ACCEPT. The rule requires both passes
to agree, so a final confirming pass was run after applying round 3's corrections.

## Final confirming pass

| Pass | Agent | Verdict | Gates |
|---|---|---|---|
| 1 | `FinalConfirm` | **ACCEPT** | artifacts_consistency, defects_verified, minimalism_compliance, plan_verifiability, deep_module_quality, vocabulary_drift — all true |

It confirmed, by independent re-read, that every artifact agrees on **zero new modules**
(`tasks.md:68`, `interfaces.md:34`, `manifest.md` R09, `proposal.md:43`,
`specs/shared-layer/spec.md`), that the zero-module reason is measured (3 test files inspect the
parse-error arrays; `tools/` holds 233 entries of which 157 are inside `node_modules`; only 2 of 7
state writers are read concurrently, one already atomic), and that R22/R23 are real.

It then answered the question the earlier rounds could not — **did the three corrections
over-shrink the plan?** No. It traced one concrete migration
(`tools/debt-ledger.mjs:444-497`): the 53-line hand-rolled tokenizer plus its flag table collapse
to about 20 lines of `node:util.parseArgs` with `allowPositionals: true` and a small catch that
maps `ERR_PARSE_ARGS_UNKNOWN_OPTION` to the existing `errors[]` message — preserving the return
shape and the exit-code assertion its test checks
(`tools/debt-ledger.test.mjs:357-368,424`) at net-negative lines.

Two inconsistencies it found were fixed before this record was written: a stale sentence in
`manifest.md` still naming the draft-3 module count, and a wrong line citation (`:440` → `:499`)
for R23.

## Verdict of record

Verdict: ACCEPT

Every executable claim in the manifest was reproduced in this session; ten claims
that did not survive verification were discarded and are recorded in `.workflow-recon.md`; the
plan's central design decision was wrong twice and corrected twice against measurement; and no
project code was modified — the deliverable is an audit and a plan whose execution is gated on
the user's choice.


## Pre-merge acceptance — three passes, two fix rounds

| Pass | Agent | Verdict | What it drove |
|---|---|---|---|
| 1 | `MergeGate` | **REJECT** | Two real regressions: a hardcoded `D:\ohmypi` path in `tools/sync.ps1` (the same defect fixed in `sync.sh` and missed in its twin), and prune's deny-list reporting OMP runtime state as deletable orphans |
| 2 | `MergeGate2` | **REJECT*** | One failing row: a planted `templates/ci/other.yml` was silently ignored — real, and my own second fix round had already found it; then fixed |
| — | author adjudication | — | Verified the *other* failing row (`skills/x/SKILL.md` IGNORED) rests on a false premise I supplied |

### Pass 1's regressions — both upheld and fixed (`1142725`)

1. `tools/sync.ps1` carried a literal `D:\ohmypi\workflow-repo\tools\sync.mjs`. The branch
   had already fixed this class in `sync.sh`; missing it in the PowerShell twin meant the branch
   reintroduced the machine-path defect the audit exists to remove. Replaced with a
   `-HarnessRoot` lookup plus an explicit error; verified with `grep -i "D:" tools/sync.ps1`
   → no matches, and by running the script from a temp dir (exit 2 with a clear message).
2. Prune's suffix deny-list let extension-less runtime files through:
   `sync-prune --harness D:/ohmypi --repo …` reported `agent/kimi-device-id` and
   `agent/last-changelog-version` as deletable, and `doctor.mjs` — which imports the same
   module — reported them too. `sync.mjs --prune --confirm` would have destroyed OMP's own
   device state.

### Pass 2's failing row — real, caused by an incomplete first fix (`0f506ad`)

The allow-list from `1142725` was applied *alongside* the deny-list rather than instead of it,
so `NEVER_SUFFIX` matched `.yml`/`.json`/`.md` first and the allow-list could never reach them.
A planted `templates/ci/other.yml` — exactly the shape the repo ships — was silently never
reported. The deny-list is now removed entirely. Two protection rules were also added, each
justified by a real file in the live tree: `HOST_CONFIG` (`config.yml`, `mcp.json`,
`models.yml` are the operator's values; the repo ships `*.example.*`) and `migration-backup`
in `NEVER_DIRS` (`.gitignore:17` already declares it operator-owned).

### The row that is NOT a defect — adjudicated by the author

Pass 2 required `skills/x/SKILL.md` to be reported as a prune candidate. It is not, and that is
correct:

- `tools/sync-prune.mjs:15` documents the walk as "каталоги манифеста: tools/, agent/, rules/,
  core/, templates/, paseo/" — `skills/` is out of scope by design.
- `tools/tests/sync-prune.test.mjs:79` (pre-existing, not written in this branch) lists
  `skills/mock-skill/SKILL.md` in its "вне каталогов манифеста" group, i.e. the exclusion is an
  asserted contract.
- `tools/sync-manifest.json` covers zero `skills/` files.
- Skills are covered by a *different* mechanism: `skills-doctor` parity (78 installed / 69 repo,
  `VERIFIED`) which `sync.mjs` reports on every run.

The expectation came from the author's own prompt to the oracle, not from the code. Recorded
rather than silently dropped, because a wrong acceptance criterion is itself a defect in the
process.

## Branch acceptance after portable-install CI change

Verdict: ACCEPT

`BranchOracleA` and `BranchOracleB` independently rechecked the committed
requirements against the branch with the OS install matrix and OMP sandbox
test. Both accepted the prior requirements unchanged. Parent verification:
`node --test tools/tests/*.test.mjs` → `tests 390`, `pass 390`, `fail 0`;
`node tools/verify.mjs --profile verify` → `29/29 checks passed`;
`node tools/verify.mjs --profile audit` → `all 15 checks clean`.
The new Linux/macOS matrix was not yet executed at this acceptance point;
its remote outcome is a separate deployment gate.

## Final-tree acceptance after the portability test fix

Verdict: ACCEPT

First matrix run (all four legs) failed for one cause: the sandbox test required
the verifier to exit 0, which cannot hold on a runner without `openspec`/`omp`.
The assertion was replaced by the machine-independent contract — Node-only
installation checks PASS, missing prerequisites are reported as FAIL, exit code
tracks the report. Two independent read-only passes (`FinalOracleA`,
`FinalOracleB`) accepted the final tree with `node --test tools/tests/*.test.mjs`
→ `tests 390`, `pass 390`, `fail 0`; `verify` `29/29`; `audit` `15/15`;
`code-size` `PASS — нарушений нет`. Remote Linux/macOS execution for the fixed
commit is recorded as NOT PROVEN at acceptance time.
