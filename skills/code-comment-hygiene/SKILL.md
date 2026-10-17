---
name: code-comment-hygiene
description: "Remove generic AI-slop code comments, keep the valuable ones, never touch code. Use when writing or reviewing comments, or cleaning AI-generated annotation noise."
---

# Code comment hygiene

Ported from anti-slop's `antislop-code` skill (MIT, miqdadbadjuber/anti-slop, pinned `439a2ef5`).
Same contract: Tell (pattern), Why (why it reads as slop), Fix (what to do instead).

## Scope guardrail

Only comments change. Never modify executable code, identifiers, imports, formatting,
indentation, whitespace, control flow, or logic. When in doubt, leave the code untouched.

## Remove these

**Decorative separators.** Banner comments from repeated characters, ALL CAPS labels,
box drawing (`// =====`, `/* ---- ROUTES ---- */`). The decoration is the message.
Fix: one plain line, or nothing.

**Restating the obvious.** `// Initialize the variable` above `let count = 0`,
`// Validate user` above `function validateUser()`. The code already says it.
Fix: remove, leave the line alone.

**Workflow narration.** `// Step 1: Validate`, `// Step 2: Process`, `// First...`,
`// Next...`. Control flow is visible in code. Fix: remove; if the flow is hard
to follow, that is a structure problem, not a comment problem.

**Empty labels.** `// Main logic`, `// Helper function`, `// Entry point`,
`// Note: This is important.` A category, not a fact. Fix: remove unless the
label carries specific information ("Note: retries happen only on 5xx" stays).

**Vague placeholders.** `// TODO: Improve this`, `// Add more validation`.
Names a feeling, not a task. Fix: remove. Keep a TODO only with enough context
to act on.

**Signature echo.** JSDoc repeating `@param price The price` for self-evident
signatures. Fix: simplify or remove the echo. Keep docs explaining rules, edge
cases, assumptions, algorithms, limitations, side effects, contracts, security.

**Decorative emoji.** `// ✅ Validation`, `// 🚀 Performance`. Visual noise in
the AI default vocabulary. Fix: plain English, or remove.

**End markers.** `} // end if`, `# End of function`. The brace already ends it.
Fix: remove, except where a genuinely long file needs one landmark.

**Over-explained comments.** Several true sentences around a one-line fact:
platform, history, issue number, version. Length is the tell. Fix: cut to the
constraint alone, one line, two at most, never three. Keep the trap, the silent
failure, the protocol rule, the cost. Drop history and reasoning chains.

**Line-by-line narration.** A comment on every trivial statement. When every
line is commented, none matter. Fix: one concise comment per logical block, or none.

**Stiff or loud wording.** "This function is responsible for validating whether
the supplied credentials are valid..." or `// MAIN LOGIC`. Fix: short
sentence-case lines in a developer voice: `// Validate credentials before
issuing a token.` Explain why, not what. Stay short.

## Never remove these

Comments explaining business logic, intent, architectural decisions, security,
performance trade-offs, concurrency, protocols, API contracts, workarounds,
edge cases, assumptions, licensing. Example that must stay:

```js
// Stripe may retry webhook deliveries for up to three days.
// Ignore duplicate events using the event ID.
```

Value is not length: a workaround note is one line about the workaround, not a
paragraph. Two lines above because two facts are real, not because two is a target.

## Checklist

Run alongside the delivery review when the task touches comments. All yes:

- Every comment adds information the code does not already show.
- No decorative separators, ALL CAPS banners, box-drawn headers.
- No restated lines, declarations, or signatures.
- No step-by-step narration.
- No empty labels or vague TODOs.
- No decorative emoji or end markers.
- Density is one per logical block, not one per line.
- Each comment is one line, two only when the second carries a new fact.
- Short, natural, sentence case.
- Scope held: only comments changed.
