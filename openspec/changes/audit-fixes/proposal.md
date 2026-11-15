# Fix the defects found by the 2026-11 audit

## Why

The audit of `62828ab` produced eight reproduced defects. Two of them made the tier gate
tell an operator that work was recorded when the validator would later reject it; one made
a corrupted state file indistinguishable from an empty project; and one made the review
gate answer "fine" to a tier it could not read. Each is fixed here at its root, with the
reproduction re-run to prove closure.

## What Changes

Gate honesty (record what validation will accept, refuse what it cannot read), operator
recovery (quarantine instead of overwrite, an audited way out of a held budget
reservation), and documentation of commands the CLI already had. Plus two rules adopted
from the agent-instruction lesson: a surgical-diff law and an explicit do-not-touch list.
