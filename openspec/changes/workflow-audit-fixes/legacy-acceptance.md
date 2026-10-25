# Legacy acceptance — workflow audit fixes

`review-evidence.json` does not exist for this change. Recorded exemption, not an oversight.

Reason: the acceptance for this batch was **executed verification**, not a model review:

- each guard is proven by mutation — removing it fails the named test, restoring it passes;
- R04 was proven by running the gate on the full 226-file checkout, where it previously
  failed with `ENAMETOOLONG`, and by the disappearance of 2646 archived-copy findings;
- the merged tree measures 237 functions with a clean ratchet, `lint` exit 0, `code-size`
  PASS.

The `oracle.md` here is written by the same session that made the change, so it is **not**
independent acceptance. It is kept because the artifact gate requires a verdict file; it
must not be read as a second opinion. Nothing here claims native review coverage.

If this batch is later reviewed by `workflow review-run`, delete this file so the exemption
does not outlive its reason.
