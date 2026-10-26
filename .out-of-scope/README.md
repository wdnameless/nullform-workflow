# Out of scope

Ideas that were proposed, considered, and **rejected with a reason**. One file per
rejection, named for the concept, so a returning proposal is answered by a citation
instead of a re-litigation.

Borrowed from `mattpocock/skills`, whose `.out-of-scope/` does exactly this. The bar for
this repo differs in one way: their entry needs only "observed failure or fits the
philosophy"; here an entry also names **what evidence would reopen it**. A rejection
without a reopening condition is a preference, and preferences belong in an ADR.

## When to add an entry

Add one when a proposal was rejected after real inspection and the same proposal is
plausible enough that someone will raise it again. Not for typos, not for anything a
test already forbids, not for work that was merely deferred (that is a `defer:` marker
or a ticket).

## Format

```
# <Concept>

Rejected: YYYY-MM-DD

## What was proposed
## Why it was rejected
## Evidence
## What would reopen it
```

## Index

- [Model-invocation flip for the skill catalogue](./model-invocation-flip.md) — 61 of 72
  skills have no other pointer; flipping them makes them unreachable.
- [LCOM4 as a quality gate](./lcom4-gate.md) — the score moves with the edge definition
  (median 2 → 4 components on one added rule), so a threshold gates an arbitrary choice.
