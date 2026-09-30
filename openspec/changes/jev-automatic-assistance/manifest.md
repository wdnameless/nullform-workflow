# Requirements — automatic JEV assistance and proven benefit

User request, verbatim:

> «Отлично внедряй, я хочу чтобы все работало автоматически и полезность была доказана.»
> «Вот ключ от openrouter — [REDACTED:OPENROUTER_API_KEY]»

This approves the preceding recommendation: automatic skill assistance and model routing for self-contained low-risk subagent slices, not automatic permission approval, tier downgrades, main-session model switching, publication or weakened Oracle gates. No user credential appears in this artifact. Parent confirmed the key with HTTP 200 and stored it in the OS credential store, not a repo/local plaintext file.

| ID | Verbatim quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «Отлично внедряй» | Native OMP automatically proposes relevant effective-registry skills (including .agents/skills), appending bounded turn context without rewriting the stable catalog/system prefix. No valid skill is invented. | in-spec |
| R02 | «все работало автоматически» | Named, self-contained, low-risk task slices automatically use an approved cheaper model at actual before_subagent_spawn; explicit caller selectors and protected/sensitive/ambiguous tasks retain their original model. Unknown identities or missing policy never guess. | in-spec |
| R03 | «Вот ключ от openrouter» | API credential remains in the native OS credential store or caller environment, never prompts, configs, git, reports, child task instructions or replay artifacts. OpenRouter requests use a live-verified Decisions endpoint. | in-spec |
| R04 | «все работало автоматически» | Installers install the native extension idempotently; this machine is activated without a manual per-task command. No credential means zero outgoing API calls. Provider errors, malformed decisions, timeout, context-dependent turns and secret-bearing input preserve baseline behavior and produce only redacted status. | in-spec |
| R05 | «полезность была доказана» | Live paired baseline/candidate evaluation has separate calibration and held-out RU/EN skill cases, deterministic outcome checks for representative low-risk tasks, actual usage/cost and latency including JEV and fallbacks. The report distinguishes measured scoped benefit from unproven whole-workflow savings; no fabricated percentage. | in-spec |
| R06 | «полезность была доказана» | Persisted validated activation policy is tied to model/candidate/catalog/evaluation fingerprints. Only measured eligible lanes activate; stale/missing/failed evidence falls back automatically. A feature that fails the benchmark is not declared beneficial. | in-spec |
| R07 | «Отлично внедряй» | T0–T3 classification, deterministic tests, secrecy controls, approvals and independent Oracle models are unchanged. Cost control is never permission to skip checks or classify risky tasks as trivial. | in-spec |
| R08 | «все работало автоматически» | End-to-end actual OMP smoke proves automatic turn assistance and actual child model selection, not only a synthetic callback test; errors/opt-out/secret paths also observed. | in-spec |
