# Unpin review models

## ADDED Requirements

### Requirement: User-configured admission route
`validatePolicy` SHALL admit a third route whose provider, model,
endpoint, tariffs, context window and credential env name all come
from the admission policy, validated for shape and bounds.

#### Scenario: Custom provider validates
- **WHEN** a policy names provider `acme`, an https endpoint, finite
  tariffs and `credentialEnv: ACME_API_KEY`
- **THEN** validation succeeds and the normalized policy carries them

#### Scenario: Pinned routes unchanged
- **WHEN** a policy names `openai` or `nullform-gateway`
- **THEN** the exact pinned model/endpoint/tariff checks still apply

### Requirement: No hardcoded OpenAI credential
Dispatch SHALL read the credential env name from the normalized policy;
`OPENAI_API_KEY` SHALL appear only as the pinned route's name and in
redaction helpers, never as a dispatch gate for other routes.

#### Scenario: Dry-run without OpenAI key
- **WHEN** `review-run --dry-run` runs with a user-configured policy
  and no `OPENAI_API_KEY` in env
- **THEN** it validates and shows the route instead of erroring
