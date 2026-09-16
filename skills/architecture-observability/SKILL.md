---
name: architecture-observability
description: Keep the human able to see their own repository — module graph, health score, plain-language findings, and what changed. Use after structural work, when the user asks "what does my codebase look like", or when they are losing track of what the agent built.
---

# Architecture Observability

## The problem this solves

When you work through an agent, the human sees a diff and a chat log. They never
see the **shape** of what is being built. Three things follow from that:

- they cannot tell whether the codebase is getting simpler or more tangled;
- they approve changes they cannot evaluate;
- they lose the mental model that let them have opinions in the first place.

A summary written by the agent does not fix this — the agent is the one whose
work is being judged. A **report generated from the code** does, because the
human can open it, see the same graph the agent sees, and disagree with the
agent's own interpretation.

## Run it

```bash
node '<HARNESS>/tools/archmap.mjs' scan   --root .   # analyze + write the report
node '<HARNESS>/tools/archmap.mjs' diff   --root .   # text delta since last scan
node '<HARNESS>/tools/archmap.mjs' json   --root .   # for you to read, not the human
```

Output: `.archmap/architecture.html` — a single self-contained file, no network,
no build step. Open it directly in a browser.

## What the report contains

| Section | What the human learns |
|---|---|
| **Health score** | Average Maintainability Index (Microsoft's normalised formula). 85+ comfortable, 65–85 workable, below 65 risky. Comparable to other tooling, not a bespoke number. |
| **What changed** | Files added/removed/modified since the previous scan, with line and branch deltas, plus any **new dependency cycles**. |
| **How it fits together** | Module graph. Arrows point at what a file imports. Red = in a cycle, amber = 600+ lines. Hover any box for lines/branches/MI/fan-in. |
| **What to look at** | Findings in plain language: what is wrong, **why it matters**, and what to do about it. |
| **Largest files** | Where the weight sits, with branch count and who imports it. |

## How to use it as the agent

1. **Scan after structural work** — new modules, moved files, refactors, dependency
   changes. Not after every edit; the value is in the delta.
2. **Read the delta back to the user in one line.** "Health +3, one new cycle in
   billing/" is more useful than a changelog. Lead with what changed, not what exists.
3. **A new cycle is a stop-and-say-something event.** Cycles are the strongest
   predictor of "I changed one file and three things broke". Name it explicitly
   even when the task succeeded.
4. **Findings are inputs, not verdicts.** They are heuristics — an honest report
   says what it measured, not what it concluded. If a finding is wrong for this
   codebase, say so and why. Do not delete a finding to make the score look good.
5. **A falling score is not automatically bad.** A large feature legitimately adds
   size. What matters is the *shape* of the fall: new cycles, a new god-module, or
   an orphaned pile are different from more lines in one coherent area.
6. **Never present the score as a grade.** It measures length and branching. It
   cannot see whether the design is right, and saying otherwise is a lie.

## Boundaries

- **Static analysis only.** No LLM, no network, nothing leaves the machine. The
  HTML is a plain file you can commit, email, or open offline.
- **Regex-based extraction.** Imports and exports are parsed per language; it can
  miss an edge at the margins. It will not manufacture findings — a miss shows as
  a missing edge, not a false alarm.
- **Not a substitute for `CODEMAP.md`.** `codemap` maps *meaning* per folder for
  the agent (`skill://codemap`). `archmap` shows *structure and trend* to the
  human. One is prose, the other is a measurement.
- **Not a substitute for Oracle review.** This measures shape, not correctness.
  A clean report and a correct implementation are independent facts.
