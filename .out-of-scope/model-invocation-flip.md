# Model-invocation flip for the skill catalogue

Rejected: 2026-10-24

## What was proposed

Mark most of the 72 shipped skills `disable-model-invocation: true` (mattpocock/skills
style: model-invoked only when the agent must reach the skill by itself). The pitch is
the always-loaded budget: every model-invoked skill's `description` sits in context on
every turn, so flips buy back tokens.

Measured baseline for the decision: **20,326 characters ≈ 5,082 tokens** for the 72
descriptions. A flip of the 61 that are not referenced by any `skill://` pointer would
reclaim that almost entirely.

## Why it was rejected

The premise of mattpocock's rule is that the human (or another skill) can still reach a
user-invoked skill: by typing its name, or through a **router skill** that names it. This
repo satisfies neither precondition:

- `disable-model-invocation` is not honored by our harness and is not documented in any
  of our own files. Grep over `agent/`, `rules/`, `docs/`, `README.md`, `CONTEXT.md`:
  zero mentions. The flag exists in `skills/nullform` and `skills/review-animations`
  only because the former came from an external plugin format.
- There is no router skill in this repo. `skills/nullform/SKILL.md` is user-invoked and
  names nothing.
- **56 of the 72 skills are both unreferenced by any `skill://` pointer (61 total,
  11 referenced) and installed in `~/.agents/skills`.** For those 56, the description is
  the *only* path by which the agent can reach the skill. Flipping them removes them
  from the agent's reach entirely — the failure is silent, because the registry simply
  stops offering them.

That is not a token optimisation; it is deleting 56 capabilities and calling the result
a saving. The mattpocock repo can afford the rule because its skills are few, curated,
and reached through an explicit slash-command habit; ours are 72 and reached by
description alone.

## Evidence

- `skills/*/SKILL.md` count: 72; distinct `skill://` targets across
  `agent/`, `rules/`, `tools/`, `skills/`, `core/`: 11.
- Installed-and-unreferenced: 56.
- Description budget: 20,326 chars ≈ 5,082 tokens (4 chars/token), dominated by
  `refero-design` (973), `tastemaker` (866), `landing-page-design` (655).
- `disable-model-invocation` appearances in our own docs/laws: 0.

## What would reopen it

Any one of these, verified:

1. The harness honors `disable-model-invocation` **and** a test proves an installed
   skill with the flag is not offered by the registry while `skill://<name>` still
   resolves. (This is the load-bearing one: without it the flag is decoration.)
2. A router skill exists that names every flipped skill, so the human and the agent both
   have a reachable path that is not the description.
3. The always-loaded budget is measured as an actual cost problem — i.e. a session
   demonstrably loses capability or money to 5K tokens of descriptions. So far there is
   no such measurement, only the theoretical saving.

Until then the honest option is pruning: delete or merge skills nobody uses, which
reclaims the same tokens without making anything unreachable.
