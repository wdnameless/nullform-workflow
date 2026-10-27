# unpin-review-models — interfaces

## T1: transport (owner: @fixer)

- `validatePolicy(policy)` (budget.mjs): accepts `provider` other than
  the 2 pinned IFF `policy.transport === 'nullform-http-v1'`,
  `endpoint` is https (http only for 127.0.0.1 fixture class),
  `tariffsUsdPerMillion` has all 4 finite ≥0 counters,
  `credentialEnv` matches /^[A-Z][A-Z0-9_]{2,63}$/,
  `contextTokens`/`maxOutputTokens` positive safe integers within
  published caps. Returns normalized policy incl. `credentialEnv`.
  OpenRouter/provider-blocklist stays. Pinned routes byte-identical.
- `credentialEnvForProvider(provider, policy?)` (http-runtime.mjs):
  gateway → NULLFORM_GATEWAY_API_KEY; openai → OPENAI_API_KEY;
  else policy.credentialEnv (throw if absent).
- evidence.mjs:467 gate uses `credentialEnvForProvider(policy.provider,
  policy)`; error names the required env var. Model check compares
  against `${policy.provider}/${policy.model}` (drop "pinned snapshot"
  wording, keep exactness).
- `withoutProviderCredential(env, key)`: default key stays
  OPENAI_API_KEY for callers without policy; dispatch path passes the
  policy's env name.

## T2: docs (owner: @sonic)

- Replace pinned-model examples with `<provider>/<model> from your
  admission-policy` + one user-configured JSON example. No other prose
  touched. CONTEXT.md term: "Requires the credential named by the
  policy at dispatch".

## T3: tests (owner: @fixer)

- Fixture provider `acme` / model `acme-1` / endpoint
  `https://acme.example/v1/chat/completions` / credentialEnv
  `ACME_API_KEY`. Same assertions, new names. No live network.
