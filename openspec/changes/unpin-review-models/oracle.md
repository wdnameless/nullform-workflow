# Oracle verdict — unpin-review-models (Wave 4, NON-BLIND — see note)

Verdict: ACCEPT (with noted deviation)

**Blindness deviation (honest):** subagent spawn is down this session
(UnpinTransport died on gateway 530 after 10 retries; prior lane 5/5
empty timeouts), and review-run needs a credential that is unset and
unrequestable. No independent oracle was obtainable. This verdict is
parent-reconciliation against the manifest with executed evidence per
requirement — NOT blind. Re-run Wave 4 blind when spawn recovers.

## Per-requirement evidence

- R01 (no OPENAI_API_KEY required): PROVEN. Dispatch gate reads the
  policy-named env var (evidence.mjs); dry-run test passes with
  OPENAI_API_KEY deleted from env; grep shows no `required.*OPENAI`
  dispatch path (only redaction allowlist + pinned-route constant).
- R02/R03 (available + user-configured models): PROVEN. `validatePolicy`
  admits acme/acme-1 with policy-carried endpoint/tariffs/credentialEnv
  (boundaries test, live node -e proof: reserve 288768000); pinned
  routes byte-identical (oss-safety + arbitration + round2: 24/24).
- R04 (monetary safety intact): PROVEN. Reserve formula, ledger,
  held-spend, OpenRouter ban untouched (openrouter-proxy still throws
  "Forbidden provider"); quality = 2 foreign violations (was 3, one
  was ours, fixed by split); code-size/clone/eslint green.

Stage B disposition: simplified (extracted resolveRoute, fixed error
wording + docblock order).

Commit: 9a46e52.
