# Interfaces — autopilot-parity

Owner per slice; zones are disjoint. Parent owns `CONTEXT.md` glossary and integration.

## Slice A — Run control (R01/R02/R05)

- `start --mode full|semi|interview|manual --depth strict|normal|deep`
  (extend `tools/workflow.mjs` `cmdStart` + state, additive). Invalid values
  fail naming the allowed set; persisted in `.workflow/state.json`.
- `freezeBrief(dir, text) → path`; `redactSecrets(text) → text`;
  `oracleInput(changeDir) → briefPath` (new `tools/brief.mjs`). Dated
  `<YYYY-MM-DD>-brief.md`; secrets → `[REDACTED:<NAME>]` (token-shaped
  patterns: api/sk-/ghp_/xox-/JWT/AWS/Telegram); oracle input resolves to the
  frozen brief only.
- `parseRequirement(row) → { id, type, status }`; `recount(rows) → counts`
  (new `tools/requirements.mjs`). Types R/Ri/G/A/D, statuses
  open/in-spec/in-ticket/done/placeholder/deferred/dropped; row = manifest
  table line parsed WITHOUT regex-split on pipes inside quotes.
- Tests: new `tools/tests/ap-run.test.mjs`.

## Slice B — Plan gates (R03/R06/R07)

- `checkPlan(manifestRows, tickets) → { ok, problems: string[] }`
  (new `tools/plan-check.mjs`). Tickets are `{ id, requirements: string[],
  wave: number, zone: string[], blockedBy: string[] }`; enforces both-way
  coverage, `wave = 1 + max(deps)`, disjoint zones per wave (prefix check).
- `coverageCheck(briefText, specText) → { found, fixed, deferred, items }`;
  `coverageGate(result) → boolean` (new `tools/coverage-check.mjs`).
  Pure structural comparison input; gate fails when found > fixed + deferred.
  Blindness is enforced by the CALLER passing only brief+spec (documented).
- `blindAccept(repoDir, briefText, runner) → { checked, matched, mismatches }`
  (new `tools/blind-accept.mjs`). Clones via `git clone <repo> <tmpdir>`,
  deletes spec/manifest/ticket paths inside the clone, runs `runner(cloneDir,
  briefText)`; throws when forbidden paths survive.
- Tests: new `tools/tests/ap-gates.test.mjs`.

## Slice C — Build discipline (R04/R08/R09)

- `validateWorkerReport(text) → { ok, violations: string[] }`
  (new `tools/worker-contract.mjs`). Requires `REDPROOF:` line + sections
  STATUS/FILES/TESTS/INTERFACES/REQUIREMENTS/CONCERNS; rejects >25 lines.
- `depthChecklist(specText) → missing: string[]` (8 dimensions);
  `adversarialPass(briefText) → questions: string[]` (7 questions)
  (new `tools/checklists.mjs`). Keyword-anchored structural checks returning
  missing item names; never LLM.
- `scoreReview(findings) → { manifest, spec, craft }`;
  `consolidateF1(blockers) → ticket`; `repairBudget(state)` (extend
  `tools/review/arbitrate.mjs`, additive). Axes scored independently;
  F1 merges branch blockers; budget enforces ≤2 repairs, ≤2 retries, 1 re-review.
- Tests: new `tools/tests/ap-discipline.test.mjs`.

## Slice D — Ops journal (R10/R11/R12)

- `recordBeat(journal)`; `honestTime(journal) → ms`;
  `askKind(journal, kind)`; `answered(journal)`; `commitsCheck(dir, commits)`
  (new `tools/journal.mjs`). Beats exclude gaps >45 min and archived waits;
  commits verified via `git merge-base --is-ancestor`.
- `carryDebts(prevDir, nextDir)`; `normalizedCost(usage, role)`;
  `verifySkillsLock(lockPath)` (extend `tools/cost-snapshot.mjs` additive for
  cost; new `tools/carry.mjs` for debts+lock). Cost = out×5 + write×1.25 +
  read×0.1 with role split + cache-churn tripwire (write/read > 0.10);
  lock verifies SHA-256 of SKILL.md files.
- `embedSnapshot(html, state) → html`; `detectCollision(dir) → boolean`
  (extend `tools/dashboard.mjs`, additive). Markers `/*STATE-BEGIN/END*/`
  with `</` escaping; collision = live state + fresh serve pid.
  Graceful shutdown + foreign-process guard as pure helpers in the same edit.
- Tests: new `tools/tests/ap-ops.test.mjs`.

## Shared non-goals

No network, no paid model calls, no provider probes, no new dependencies,
no edits outside the assigned zone, no `CONTEXT.md`/openspec/`.workflow/` edits.
