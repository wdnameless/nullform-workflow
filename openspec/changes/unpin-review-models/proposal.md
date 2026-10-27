# unpin-review-models — proposal

## Why
`review-run` dispatches only through two hardcoded routes (OpenAI pinned
snapshot, nullform gateway) and demands `OPENAI_API_KEY` at the dispatch
boundary. The user forbids the OpenAI key: review must run on AIs
available in the environment or set by the user in config. Today that is
impossible — any third provider throws "not a verified admitted route".

## What Changes
- **Third route `user-configured`** in `validatePolicy`: provider, model,
  endpoint, contextTokens, tariffs all come from the admission policy
  (validated: https endpoint, finite tariffs, sane bounds); credential
  env var NAME comes from the policy (`credentialEnv`), never hardcoded.
- **Credential gate** in evidence.mjs + `credentialEnvForProvider` read
  the env name from the normalized policy; `OPENAI_API_KEY` remains only
  as the pinned route's name and in redaction helpers.
- **oracle-model.mjs reuse**: `--model` may name a `models.yml` selector;
  resolution already exists (`resolveOracleModel`) — review-run accepts
  its output instead of demanding the pinned literal.
- **Docs + tests move together**: orchestrator.md, PORTABLE.md, skill,
  CONTEXT.md term, 5 test files — pinned-OpenAI fixtures become
  user-configured fixtures.

## Non-Goals
- New transports (still `nullform-http-v1` only), new ledger math
  (reserve formula unchanged), removing the allowlist (still 3 routes,
  OpenRouter still forbidden), touching product-command sandboxing.
