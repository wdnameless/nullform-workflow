---
name: requesting-code-review
description: Dispatch code review subagent to catch issues before they cascade. Use after completing tasks, before merging, or when stuck. Integrates with git to review specific commit ranges.
---

# Requesting Code Review

Dispatch code-reviewer subagent to catch issues before they cascade.

Core principle: Review early, review often.

## When to Request Review

**Mandatory:**
- After each task in subagent-driven development
- After completing major feature
- Before merge to main

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug

## How to Request

1. Get git SHAs:
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main
HEAD_SHA=$(git rev-parse HEAD)
```

2. Dispatch code-reviewer subagent:
Use Task tool with oracle subagent type, provide:
- `{WHAT_WAS_IMPLEMENTED}` - What you just built
- `{PLAN_OR_REQUIREMENTS}` - What it should do
- `{BASE_SHA}` - Starting commit
- `{HEAD_SHA}` - Ending commit
- `{DESCRIPTION}` - Brief summary

3. Act on feedback:
- Fix **Critical** issues immediately
- Fix **Important** issues before proceeding
- Note **Minor** issues for later
- Push back if reviewer is wrong (with reasoning)

## Example

```
[Just completed Task 2: Add verification function]

You: Let me request code review before proceeding.

BASE_SHA=$(git log --oneline | grep "Task 1" | head -1 | awk '{print $1}')
HEAD_SHA=$(git rev-parse HEAD)

[Dispatch oracle subagent]
  WHAT_WAS_IMPLEMENTED: Verification and repair functions for conversation index
  PLAN_OR_REQUIREMENTS: Task 2 from docs/plans/deployment-plan.md
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661
  DESCRIPTION: Added verifyIndex() and repairIndex() with 4 issue types

[Subagent returns]:
  Strengths: Clean architecture, real tests
  Issues:
    Important: Missing progress indicators
    Minor: Magic number (100) for reporting interval
  Assessment: Ready to proceed

You: [Fix progress indicators]
[Continue to Task 3]
```
## PR Body (before requesting merge)

Every PR going to `main` carries a body in `.github/pull_request_template.md` shape:
Summary → Evidence (before → after) → Merge danger → Blast radius.
A PR without runtime evidence is not ready for review — same bar as the oracle
evidence protocol (`agent/agents/oracle.md` § EVIDENCE PROTOCOL).

- **Summary**: 2-5 sentences, what + why. Refactors name the merged concepts.
- **Evidence**: exact command + raw output/counts on a real path
  (e.g. `node --test tools/tests/<name>.test.mjs` → `pass 12, fail 0`).
  Requiring evidence makes the author run the extra test instead of claiming
  "probably works, I read the code".
- **Merge danger**: `two-way door` (plain revert restores state) or `one-way door`
  (data migration, irreversible public action, external side effect — name it).
- **Blast radius**: small (isolated module) / medium (shared contract) / large
  (public API, data shape) + the affected surfaces by name.
- Reviewer checks the body: missing/stale evidence = review finding, not a nit.

## Integration with Workflows

**Subagent-Driven Development:**
- Review after EACH task
- Catch issues before they compound
- Fix before moving to next task

**Executing Plans:**
- Review after each batch (3 tasks)
- Get feedback, apply, continue

**Ad-Hoc Development:**
- Review before merge
- Review when stuck

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback

**If reviewer wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification
