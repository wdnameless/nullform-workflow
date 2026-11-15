# Full audit — nullform-workflow @ 62828ab

Scope: 1573 tracked files, 127 source modules (50 102 lines), 122 test files.
Method: every gate run; targeted probes written to `.tmp/` and executed; each
finding below was reproduced or read to a definite line.

## Gate results (baseline, all green)

| gate | command | result |
|---|---|---|
| ESLint | `eslint tools/ bin/ bench/checks/` | exit 0, 0 problems |
| size | `code-size.mjs check` | PASS, 301 files, 4 exempt |
| COCO | `quality.mjs check` | PASS (node 222 fns, python 42 fns) |
| clones | `clone-coverage.mjs check` | PASS, 13.9 % coverage, 890 clones |
| debt | `debt-ledger.mjs scan` | 23 markers, 0 without upgrade trigger |
| prompts | `prompt-lint.mjs scan` | findings only in ~/.agents, none in repo |
| agents | `agent-lint.mjs --check` | 8 agents clean |

CI: 22/22 jobs green on `master` (verified run 42406574354).

## Scores

| dimension | score | basis |
|---|---|---|
| Architecture | 7/10 | Clean seam between state (`workflow-core`), gates (`workflow-ci`), review evidence (`review/`), and presentation (`dashboard-*`). Against that: 5 modules exceed 1000 lines (largest 1680), 109 functions take >=5 parameters, and `workflow.mjs` (1121 L) carries a `defer:` rather than a split. |
| Correctness | 6/10 | Verified strong: atomic state write (tmp+rename), cross-process lock on start (8 racers, exactly 1 winner), close re-validates artifact bodies, budget ledger uses lock+tmp+rename+fsync with unsafe-integer and over-spend guards. Against that: two P1s below are reachable by an ordinary operator. |
| Test quality | 7/10 | 122 files / 41 481 lines vs 48 816 source lines. 105 of 127 modules are referenced by some test. Real integration (git worktrees, HTTP fixtures, spawned children), not mocks. Weakness: one gate test passes when its probe crashes; 5 test blocks contain no `assert` of their own. |
| Security | 6/10 | Containment rejects `../`, absolute-outside and sibling-prefix escapes; branded-executor `WeakSet` blocks forged provider claims; ledger is nonce-locked. Gaps: two containment helpers differ in strictness and the lexical one is used alone in 4 settle paths; redaction is literal-only (base64 and newline-split secrets survive). |
| Maintainability | 6/10 | 161 empty `catch` blocks in source, 14 `shell:true` spawn sites, 23 acknowledged `defer:` markers, 15 commands with no documented usage line. Each defensible alone; together they let failures and features vanish quietly. |

## Findings, ranked

### P1 — the harness rejects the openspec `skip_specs` escape its own tool recommends
`tools/workflow.mjs:403-407` requires a non-empty `specs/` directory unconditionally
at `artifact --kind openspec` time, and `workflow-core.mjs` `openspecFileProblems`
does the same at `check` time. The openspec CLI's own error text tells the operator
to set `skip_specs: true` in `.openspec.yaml` for a docs/tooling change. Reproduced
during this audit:

    openspec validate audit-workflow          -> "Change 'audit-workflow' is valid"
                                                 (with skip_specs: true)
    workflow artifact --kind openspec ...     -> "missing non-empty specs/ directory"

So the harness and the tool it invokes disagree about what a valid change is. A
read-only audit, which by definition changes no behaviour, cannot be recorded
without fabricating a spec delta. Fix: consult the same `.openspec.yaml` marker
(or delegate the whole judgement to `openspec validate`, which already returns a
verdict) instead of re-deriving the rule.

### P1 — 7 dispatcher commands are absent from `--help`; 15 of 23 have no usage line in any doc
`tools/workflow.mjs --help` names 16 of the 23 dispatchable commands. Missing
entirely: `claim`, `release`, `context`, `ask`, `answered`, `gate-pass`, `settle`.
Verified by diffing the live `--help` output against the `case "..."` labels:

    dispatchable: 23   named in --help: 16
    not named: claim, release, context, ask, answered, gate-pass, settle
    `workflow claim --help` -> "Unknown flags, extra positional arguments or missing flag values"

Across every shipped doc (`docs/`, `agent/`, `skills/`) 15 commands have no
`workflow <cmd>` usage line. The whole claim/protocol surface, which the
orchestrator protocol depends on for isolated writers, is effectively
undiscoverable from the CLI. The feature works; only its front door is missing.

### P2 — `doctor` reports a stale installation as if the code were broken
Both installed harnesses on this machine fail `tools-syntax`:

    doctor --json -> harness C:\Users\Administrator\.openhuman\workflow
      "отсутствуют обязательные инструменты: review/evidence.mjs, ... (16 files)"
    doctor --json --harness omp -> harness C:\Users\Administrator\omp-workflow
      same failure, plus tools-smoke and agent-wiring

The files exist in the repository and all 16 are listed in
`tools/sync-manifest.json` (137 entries; 11 `tools/review/*`, 8
`tools/installation/*`, 2 `tools/workflow/*`). So the install simply predates the
directories. That is a real operational hazard: the diagnostic that is supposed to
tell you "your harness is healthy" instead reports missing core tools with no hint
that the remedy is `nullform update`. Suggest the message name the remedy.

### P1 — `artifact` accepts what `check` will reject (record-time validation gap)
`tools/workflow.mjs` `cmdArtifact`. T2 binds `manifest` and `interfaces` to the
change directory (`isChangeScopedKind` in `workflow-core.mjs`), but the recording
path only checks existence and containment. Reproduced:

    artifact --kind openspec  --path openspec/changes/probe   -> 0
    artifact --kind manifest  --path manifest.md              -> 0  (recorded)
    check                                                     -> 1
      manifest: 'manifest.md' belongs to another change, not 'openspec/changes/probe'

Cost: the operator is told the artifact is recorded, then fails much later with a
message that names a different directory than they typed. Move the
`changeDirOf`/`relative` test into the recorder.

### P1 — a corrupted `state.json` is indistinguishable from "no task"
`workflow-core.mjs:48-63` `load()` returns `null` for both a missing file and an
unparseable one. Reproduced: truncate `state.json` mid-write, then

    status  -> exit 0, "workflow: no active task."
    start --tier T0 ...  -> exit 0, opens a fresh lane
    (the open T2 lane and its name are gone, no warning, no backup)

`save()` renames atomically, so the reachable window is external corruption or
disk failure — but the reaction is silent loss of an open lane, not a refusal.
Suggest: on `JSON.parse` failure, rename the bad file to `state.json.corrupt-<ts>`
and exit non-zero with a recovery hint.

### P2 — `validateReviewEvidence` returns `ok:true` for any non-`T2`/`T3` tier value
`tools/review/evidence.mjs:626`: `if (!['T2','T3'].includes(tier)) return { ok: true, errors: [] }`.
Reproduced across `['T2']`, `[]`, `'t2'`, `null`, `undefined`, `2` — all `ok:true`.
CLI callers (`cmdCheckCi`) normalise with `toUpperCase()` and validate against
`['T0','T1','T2','T3']` first, so no shipped path reaches it. `evidence-history.mjs:24`
even has an `Array.isArray(tier)` branch that feeds arrays through. As an exported
API this is a footgun: a typo in the tier silently disables the review gate.
Suggest: reject unknown tiers with an error rather than treating them as T0.

### P2 — a held budget reservation has no recovery path
`budget.mjs:400` blocks every new admission while any reservation is `held`,
"regardless of ceiling". Reproduced: admit, `holdReservation`, raise the ceiling
to 1000 USD — still refused. The exported surface contains no
release/clear/force function; recovery requires hand-editing
`nullform-review-budget.json`. CONTEXT.md documents the refusal as intentional,
but the absence of any audited recovery command means the documented escape is
"edit the ledger by hand", which the same paragraph forbids.

### P2 — `success()` in the controlled-HTTP test can pass on a crashed probe
`tools/tests/review-controlled-http.test.mjs:210` `gate()` catches any spawn
failure and returns `{ ok:false, errors:['gate probe failed'] }`; the tamper test
at `:547-549` asserts exactly `ok === false` and `errors.length > 0`. Verified
that a crashed probe satisfies both assertions, so the test proves nothing about
tamper detection when the probe is broken. Fix: assert the error text is the
integrity error, not `'gate probe failed'`.

### P3 — the legacy-marker bypass has no test and no content requirement
`validateReviewEvidence` accepts `legacy-acceptance.md` on existence alone
(`evidence.mjs:635`). Reproduced with a **zero-byte** file: gate returns
`{ok:true, legacy:true}`. The bypass is intentional and documented in the code
comment, but: (a) `grep -rn legacy-acceptance tools/tests/` finds no test, and
(b) an empty file is accepted, so the "reason" the error message asks for is
never checked. Suggest requiring a non-empty reason line.

### P3 — redaction misses encoded forms
`redactSecret` (budget.mjs:49) does a literal substring replacement.
Reproduced: a base64 `Authorization: Basic <b64(key)>` survives, and a key split
across a newline in an upstream error body survives. Literal `Bearer <key>` is
correctly redacted. Low frequency, but the failure mode is "credential in a
retained run file".

### P3 — two containment helpers with different strictness
`isPathInsideRoot` is purely lexical (`worktree-snapshot.mjs:23`); it accepts
`root/link/secret` where `link` is a junction to outside — reproduced `true`.
`isRealPathInsideRoot` and `validatePathWithinScope` resolve real paths and
reject it. Most call sites pair them, but `workflow-ci.mjs:1045/1074/1120/1150`
use the lexical one alone (settle-cleanup target gathering). Those paths come
from git output and directory listings, so the risk is bounded, but the naming
invites the unsafe one. Suggest renaming: `isLexicallyInside` vs `isInsideRoot`.

## What is genuinely good (verified, not assumed)

- Budget authority: cross-process lock via `wx` + token, `tmp`+`rename`+`fsync`
  (including the directory fsync on POSIX), unsafe-integer guards, tariff snapshot
  captured per reservation, observed spend cannot exceed the reservation.
- Concurrent `start`: 8 parallel processes, exactly 1 succeeded, state parsed clean.
- `close` revalidates artifact bodies: mutating `manifest.md` after recording is
  caught by the close gate, not just by `check`.
- Verdict regex: rejects fenced/quoted ACCEPT when a real REJECT is present.
- Secret redaction of the common `Bearer <key>` form; branded-executor `WeakSet`
  so a forged object cannot claim the direct-provider class.
- Containment: `../` escape, absolute-outside, sibling-prefix (`rootEvil`) all rejected.

## Not reproduced / not claimed

- `workflow-workspaces.test.mjs` "foreign root" test flagged by a crude scanner as
  assertion-free: it delegates to a `refused()` helper that asserts. False positive.
- `CONTEXT.md` `skills/auto_load` "missing path": prose about a legacy format.
- Stage-B `--test-cmd` runs through `shell:true`; it is an operator-supplied flag and
  `benchmark.mjs:12` documents the trust boundary. Risk, not defect.

## Deviation recorded for this audit lane

The T2 lane requires native review-evidence (`review-evidence.json` produced by a
real provider call). The provider quota was exhausted before this session
(`429 Individual quota reached`, reset in ~140 h), so no review execution could be
recorded. The lane is closed with `--force --reason`, which records the deviation
visibly rather than silently. The oracle verdict above is an auditor's reading, not
provider-backed evidence, and is marked as such.

## Re-verification

Every finding above was re-run from a clean temp directory after the report was
written:

| finding | re-run output |
|---|---|
| record-time path gap | `manifest recorded (m.md) — 2/6 for T2`, exit 0 |
| corrupt state | `status` exit 0 "no active task"; T2 task not recoverable |
| unknown tier accepted | `['T2'] [] 't2' null undefined 2` all `ok=true` |
| held reservation | refused at a 1000 USD ceiling |
| legacy marker | zero-byte file returns `{ok:true, legacy:true}` |
| help omissions | 7 of 7 still absent from `--help` |
| gate-crash false pass | a crashed probe satisfies both assertions |
| base64 secret | survives redaction |
