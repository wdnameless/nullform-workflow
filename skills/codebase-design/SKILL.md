---
name: codebase-design
description: Design deep modules with narrow interfaces and clear testing seams. Avoid shallow wrappers.
---

# Codebase Architecture & Deep Module Design

Principles derived from John Ousterhout's *Philosophy of Software Design* and Michael Feathers' *Working Effectively with Legacy Code*.

## 1. Deep vs Shallow Modules
- **Deep Module**: An abstraction with a simple, narrow interface that conceals complex, non-trivial implementation details (e.g. Unix file I/O: open/read/write/close).
- **Shallow Module**: An interface that is relatively complex compared to the small functionality it provides, or 1:1 pass-through wrappers.

## 2. The Deletion Test
To verify if a module or abstraction earns its place:
- Mentally or experimentally delete the module.
- If deleting it causes its complexity to vanish without spilling into callers, it was an unnecessary shallow wrapper. Delete it.
- If deleting it causes significant complexity to spill across N callers, the module is load-bearing and deep. Keep it.

## 3. Seam Placement & Dependency Inversion
- A **seam** is a place where behavior can be altered or intercepted without editing the consuming source code.
- **Consumer-Defined Interfaces**: Interfaces belong to the consumer package/module that uses them, not to the provider that implements them.
- Inject dependencies across seams to allow fast, isolated deterministic tests.
- **Composition over implementation inheritance**: reuse through `extends` (except `Error`) drags the parent in as many directions as it has children — cohesion of the reused class degrades (Bieman & Kang 1995, confirmed opposite of their hypothesis). In review, an `extends` is a question, not a pattern; subtyping (interface refines interface) is exempt.
- **Registry contract**: a module past ~25 exported functions is a registry or dispatcher by contract, not a unit — name the contract (what independence buys the callers), or split. Past the line without a named contract is a `split:` finding.

## 4. Cohesion: why a module's parts belong together

Coupling and cohesion were proposed together (Structured Design, 1974) and are one
decision: low coupling is reached either by separating modules **or** by making each
module internally whole. The second is cheaper, so cohesion is the lever.

Six levels of intra-module binding, weakest to strongest — name the level, not a number:

| Level | Parts are together because | Smell |
|---|---|---|
| Coincidental | nothing; they were at hand | `helpers/`, `utils/`, `misc` |
| Logical | same theme, no shared data | `string-utils` with trim/capitalize/repeat |
| Temporal | invoked at the same time | "parse the row right after the query returns" |
| Communicational | operate on the same input/output data | one class wrapping a `ResultSet` |
| Sequential | output of one is input of the next | parse → get, forced order |
| Functional | every part contributes to one function | the SRP case |

Functional is the only level that survives contact with a reviewer; coincidental is a
finding. The tension is real: merging more parts into one module always costs cohesion,
splitting always costs coupling. Choose the level you can name in one sentence.

**Form follows function.** Derive the module list from the functions first; never pick
a box count and then fill it. "Four components feels right" produces a `helpers` zone.

**LCOM4, if you measure at all.** Nodes are methods and attributes; an edge is
"method reads attribute" or "method calls method"; the score is the number of connected
components. 1 is good; each extra component is a region that could be its own module.
It is a **diagnostic that starts a conversation, not a gate**: the score flips with the
edge definition (does a shared parameter count? does a registry count?), so a threshold
turns one arbitrary choice into a build failure. Treat an integer above 1 as a question.

## 5. A metric is a hypothesis until it is validated against people

Any number about design (LCOM, cyclomatic, cognitive, maintainability, COCO, LOC) is a
proxy. It earns the right to block a build only after:

1. it was computed over a corpus large enough to contain the degenerate cases
   (thousands of units, not twenty);
2. its verdicts were compared with human judgement on sampled units, blind;
3. agreement is materially above chance — above 50% is the floor, and it will never
   approach 100%.

`tools/quality.mjs` (COCO) and `tools/code-size.mjs` (lines) are the two metrics this
repo does gate, and each has a known ceiling recorded in its header. A new gate owes
the same evidence plus its own stated ceiling; a formula that has only been argued for
belongs in a diagnostic, not a gate.
