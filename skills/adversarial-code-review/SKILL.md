---
name: adversarial-code-review
description: Adversarial code review - review as if trying to break the code. Use when reviewing code changes, PRs, or auditing codebase for bugs, security issues, and hidden problems. Applies 6 adversarial lenses to find issues before users do.
---

# Adversarial Code Review

Core Principle: Review as if you're trying to break the code. Deliberately adopt hostile perspectives—each reveals issues the others miss.

This is not about finding fault. It's about finding problems before users do.

## Review Mode

| Mode | Trigger | Focus |
|------|---------|-------|
| Diff-Focused (default) | No explicit instruction, PR review | What changed? What could break? |
| Audit | "audit", "holistic", "codebase review" | Broader scope, systematic coverage |

When in doubt, use diff-focused mode. Audit mode requires explicit request.

## The Six Adversarial Lenses

Review through each lens deliberately. Don't blend them—switching perspectives forces deeper analysis.

| Lens | Core Question | Reveals |
|------|--------------|---------|
| Malicious User | "How would I exploit this?" | Input validation gaps, injection vectors, privilege escalation |
| Careless Colleague | "How would this break if used wrong?" | API misuse, unclear contracts, error handling gaps |
| Future Maintainer | "What will confuse me in 6 months?" | Implicit assumptions, missing context, temporal coupling |
| Ops/On-Call | "How will this fail at 3am?" | Observability gaps, recovery paths, failure modes |
| Data Integrity | "What happens to state?" | Race conditions, partial failures, consistency violations |
| Interaction Effects | "What does this change elsewhere?" | Unintended side effects, behavioral changes, contract breaks |

## Lens Details

### Malicious User
Assume the user is actively trying to break or exploit the system.
- What inputs are trusted that shouldn't be?
- Can I escalate privileges or access unauthorized data?
- What happens if I send malformed/oversized/unexpected input?
- Are there injection points (SQL, XSS, command, path traversal)?

### Careless Colleague
Assume another developer will use this code without reading documentation.
- Is the API intuitive or are there "gotchas"?
- What happens if methods are called in wrong order?
- Are error messages helpful or cryptic?
- Could someone misuse this and get silent wrong results?

### Future Maintainer
Assume you'll revisit this code in 6 months with no memory of writing it.
- Why does this code exist? Is that documented?
- What assumptions are implicit that should be explicit?
- Are there magic numbers/strings without explanation?
- Would I understand the control flow on first read?

### Ops/On-Call
Assume this will fail in production at the worst possible time.
- How will I know when this fails? (Logging, metrics, alerts)
- Can I diagnose the problem from logs alone?
- Is there a recovery path? Can it be retried safely?
- What's the blast radius if this fails?

### Data Integrity
Assume multiple things will try to modify state simultaneously.
- What happens if this runs twice concurrently?
- Are there partial failure states that leave data inconsistent?
- Is there a transaction boundary? What if it fails mid-way?
- Are reads and writes properly synchronized?

### Interaction Effects
Assume this change has consequences beyond its immediate scope.
- What calls this? Will their expectations still hold?
- What does this call? What assumptions are we making?
- Does this subtly change behavior callers depend on?
- Are there caches, indexes, or derived data that need updating?

## Review Workflow

Copy this checklist when starting a review:

```
Adversarial Review Progress:
- [ ] Step 1: Determine mode (diff-focused or audit)
- [ ] Step 2: Understand the change/code purpose
- [ ] Step 3: Apply lenses (prioritize by risk, ~5 min each):
  - [ ] Malicious User
  - [ ] Careless Colleague
  - [ ] Future Maintainer
  - [ ] Ops/On-Call Engineer
  - [ ] Data Integrity
  - [ ] Interaction Effects
- [ ] Step 4: Filter findings through Impact Filter
- [ ] Step 5: Classify severity (Must Fix / Should Fix / Consider)
- [ ] Step 6: Limit "Consider" items to max 2
- [ ] Step 7: Identify at least one positive
- [ ] Step 8: Format report
```

## Lens Prioritization

| Code Type | Priority Lenses |
|-----------|----------------|
| User input handling | Malicious User, Data Integrity |
| API/public interface | Careless Colleague, Interaction Effects |
| Background jobs | Ops/On-Call, Data Integrity |
| Business logic | Future Maintainer, Interaction Effects |
| Database operations | Data Integrity, Ops/On-Call |

## The Five Iron Laws

1. **Severity matches actual risk, not theoretical worst-case**
2. **Every "Must Fix" requires demonstration or clear reasoning**
3. **Alternative suggestions are optional, not mandated**
4. **Acknowledge at least one thing done well**

## Impact Filter

Every potential finding must pass this filter. Score 2+ to report:
- [ ] Likely to occur (probability)
- [ ] Impactful if it occurs (severity)
- [ ] Non-obvious to the author (added value)

If a finding scores 0-1, don't report it. You're adding noise, not value.

## Severity Tiers

| Tier | Definition | Action | Examples |
|------|-----------|--------|----------|
| Must Fix | Breaks correctness, security, or data integrity | Block merge | SQL injection, race condition causing data loss, auth bypass |
| Should Fix | Likely problems but not immediately broken | Fix before or soon after merge | Missing error handling, unclear naming, no tests for edge case |
| Consider | Style, optimization, theoretical concerns | Max 2 per review | Could be more idiomatic, minor perf optimization |

## Reporting Format

```markdown
## Summary
[1-2 sentence overview of the review]

### What's Done Well
- [Specific positive observation]

### Must Fix
#### [Issue Title]
**Location:** `file.py:45-52`
**Lens:** [Which lens found this]
**Issue:** [Clear description of the problem]
**Impact:** [What happens if not fixed]
**Suggestion:** [Optional - how to fix]

### Should Fix
[Same format as Must Fix]

### Consider
[Brief bullet points only - max 2 items]
```

## Key Principle
The goal isn't to find as many issues as possible. It's to find the issues that matter before they reach users.
Quality over quantity. Impact over volume. Trust over thoroughness.
