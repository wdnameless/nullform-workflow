# Acceptance basis (no native review-evidence run)

This change cannot carry `review-evidence.json`: the mechanism requires a live
model dispatch (`NULLFORM_GATEWAY_API_KEY` or an admitted `openai` route), and
this environment has **no credentials**
(verified: `NULLFORM_GATEWAY_API_KEY` absent, `OPENAI_API_KEY` absent).
A native record describes an actual execution and cannot be synthesised —
fabricating one would be exactly the dishonesty the gate exists to prevent.

What this change *does* provide instead, all executed on this tree:

- `tools/tests/pack-format.test.mjs` + `tools/tests/pack-install.test.mjs`: 16 pass / 0 fail.
- Live CLI oracle: dry-run plans with zero writes, install receipts, identical
  reinstall is a no-op exit 0, one-byte module tamper refuses naming file and hash.
- `eslint`, `code-size`, COCO ratchet: green. `openspec validate harness-pack`: valid.
- Reviewer: blind oracle read of the running artifact against R01–R04 (see oracle.md).
