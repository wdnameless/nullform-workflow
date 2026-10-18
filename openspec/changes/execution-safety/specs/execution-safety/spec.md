# Execution Safety Specification

## ADDED Requirements

### Requirement: Exclusive scoped task authority
The workflow SHALL issue owner release authority only to the successful acquisition response and SHALL bind the active task contract to its canonical execution workspace.

#### Scenario: Competing owner
- GIVEN a live claim held by agent A
- WHEN a distinct CLI process for B tries to acquire or inspect that task
- THEN it cannot obtain A's token from any refusal, read or context packet, and A's bytes remain unchanged.

#### Scenario: Different task IDs overlap
- GIVEN A holds a live claim on a canonical file in one workspace
- WHEN B acquires a different task ID naming the same canonical file in that workspace
- THEN acquisition refuses without changing A's authority; a separate isolated workspace remains independent.

#### Scenario: Immutable bounded contract
- GIVEN an acquired task pins its explicit requirement IDs, file scope, verification argv and source identities
- WHEN the contract or manifest changes, exceeds its byte bounds, or names an unknown requirement
- THEN it cannot silently change the active task packet or acquire unbounded/invalid authority.

#### Scenario: Release and replacement
- GIVEN an owned task is released with its exact active token
- WHEN another owner acquires the same task
- THEN the replacement has fresh authority and preserves historical disposition, and the previous token cannot release it.

#### Scenario: State and context links
- GIVEN a root, state ancestor, claim leaf, contract or context ancestor redirects outside its canonical scope
- WHEN claim, read, release or context is requested
- THEN it fails before outside bytes are read, created or overwritten.

#### Scenario: Concrete bounded task packet
- GIVEN a valid contract with change, owned relative files and real verification argv
- WHEN context is requested for its active task in the same canonical workspace
- THEN it returns only the task's contract, requirements and base/workspace identity, without release authority; mismatched change/workspace and ended claims refuse.

### Requirement: Explicit model admission
The workflow SHALL refuse unapproved model execution before dispatch, SHALL reject OpenRouter and unverified gateways, and SHALL distinguish known zero cost from unknown accounting.

#### Scenario: No spending authority
- GIVEN missing policy, disallowed provider, unknown effective endpoint, invalid bounded policy or exhausted ceiling
- WHEN native review is requested
- THEN no model child or inference request is dispatched, and a bounded actionable reason is returned.

#### Scenario: Supported bounded transport
- GIVEN an explicitly approved effective direct route with enforceable request limits
- WHEN native requests run against deterministic local protocol fixtures
- THEN every dispatched request has prior durable authority, bounded context/output/attempts, and settlement consistent with native usage; unaccounted cancellation holds further admission.

#### Scenario: Unenforceable execution boundary
- GIVEN a native runtime that cannot establish actual route or enforce the approved request ceiling
- WHEN execution is requested
- THEN it reports unsupported boundary and refuses rather than advertising an unenforced hard budget.

#### Scenario: Known zero price
- GIVEN complete native provenance with real nonzero token counters and a known finite zero tariff
- WHEN the receipt is validated
- THEN it is accepted under the same source, model, timestamps and independent-session rules as a positive-price receipt; unknown/negative/nonfinite cost still fails.

### Requirement: Recover exact completed work
The workflow SHALL retain completed execution evidence across failed publication and SHALL reconcile it only under the original matching execution contract.

#### Scenario: Completed provider, failed publication
- GIVEN an actual completed native transcript bound to current source/tests/manifest/role/prompt/model/command and failed receipt publication
- WHEN an explicit resume is requested
- THEN the same transcript is imported at most once without a second model dispatch.

#### Scenario: Uncertain recovery
- GIVEN an incomplete, adverse, duplicate, changed-source or tampered execution
- WHEN resume is requested
- THEN it cannot become a fresh ACCEPT or authorization to rerun; original evidence remains visible.

### Requirement: Honest integration readiness
The workflow SHALL freeze a candidate before later separately authorized model acceptance and SHALL preserve source-bound release gates and historical quality results.

#### Scenario: Actual local client evidence
- GIVEN locally available Hermes/OMP and isolated native homes
- WHEN bounded non-inference version/configuration and public installation/reapply paths execute
- THEN observed configuration and actual executed commands are reported separately; unauthenticated Claude, removed Codex, child inheritance and general quality improvement remain unverified unless exercised.

### Requirement: Consume a real Hermes policy surface
The adapter SHALL use the supported native additive agent.system_prompt field rather than infer loading from an unconsumed skills.auto_load entry.

#### Scenario: Preserve and consume native policy
- GIVEN an isolated Hermes profile with a human prompt, YAML comments and unrelated native settings
- WHEN installation and reapplication configure the managed lightweight policy
- THEN human content remains intact, the native agent.system_prompt contains one managed block, and the real installed consumer can retrieve that policy without model inference.

#### Scenario: Respect native overrides and human changes
- GIVEN an ephemeral prompt override, ignored rules, malformed prompt field or modified/unknown ownership block
- WHEN installation or doctor runs
- THEN the override is not bypassed or silently overwritten and a precise manual/conflict outcome is reported; legacy skills and unconsumed settings are not described as successful automatic loading.

### Requirement: Enable genuinely bounded physical requests
The user-approved controlled executor SHALL have a real production execution path given explicit spending authority and credentials, not permanently reject every supported request.

#### Scenario: Conservative session reservation
- GIVEN a verified exact direct model snapshot and an approved project ceiling
- WHEN a session is admitted
- THEN a serialized durable reservation covers every allowed request at full verified context-window input cost plus bounded output cost before any HTTP dispatch; concurrent runs and policy changes cannot reset or oversubscribe the ledger.

#### Scenario: Real controlled tool loop
- GIVEN the same transport mechanism with a real local HTTP provider fixture and dummy auth
- WHEN a model response requests allowed source inspection or the fixed product command, then a final report
- THEN the actual requests carry the capped output, fixed model and text-only protocol, the report and exact usage have explicit controlled-executor provenance, and no fixture response is described as native OMP or quality evidence.

#### Scenario: Ceiling and uncertain request boundary
- GIVEN an exhausted request count, insufficient money, redirect, timeout, invalid usage or missing terminal accounting
- WHEN execution or a fresh admission is attempted
- THEN no unauthorized follow-up request is sent and unresolved spending remains held rather than released as zero.
