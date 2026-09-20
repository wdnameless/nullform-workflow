# Oracle Acceptance — context-pipeline

Verdict: ACCEPT

## Evidence by Manifest Requirement

- **R01 (Context intake pipeline)**: Proven. tools/context-inbox.mjs init/request/list/resolve/check run in a temp dir: init exited 0 creating context/ with 6 categories + README/REQUESTS; request printed drop path context/design/ and added row c1,c2 (exit 0); resolve c2 -> done (exit 0); check exit 0 (well-formed); check --strict exit 1 with an open request. REQUESTS.md is a machine-readable table (| ID | Category | Needed | Why | Status | Added |).
- **R02 (Domain-context collector)**: Proven. node tools/domain-context.mjs --domain archmap printed FILES (17 found, 15 shown), RECENT COMMITS, ISSUES (graceful 'нет связанных issue'), NOTES (missing codemap + gh-none). Without --domain exited 2. No network beyond optional gh.
- **R03 (Media-context skill)**: Proven. skills/media-context/SKILL.md present: pipeline yt-dlp -> faster-whisper with exact commands, outputs to context/<category>/, fallbacks for missing yt-dlp/whisper, privacy note (Local-Only, Zero Uploads). Shipped to C:/Users/Administrator/.agents/skills/media-context/SKILL.md and recorded in installed baseline.
- **R04 (Human-plan rule)**: Proven. agent/agents/orchestrator.md:93 'proposal.md stays human-readable… details live in interfaces.md and tasks.md'; plus context-inbox list --json and domain-context (l91) and oracle-model ensure --probe (l99) wiring.
- **R05 (Ponytail lens)**: Proven. agent/agents/reviewer.md:91 Mandatory 'Simplest solution (Ponytail)' lens — flag over-engineering/DRY as Should Fix.
- **R06 (Oracle model autoselect)**: Proven. node tools/oracle-model.mjs list --json and list --json --probe both resolve nullform-gateway/gemini-3.8-flash-high (fallback entry present in agent/oracle-priority.example.json); probe degrades gracefully (omniroute timeout note). tools/tests/oracle-model.test.mjs 6/6 pass (covers fallback, config-write preserves unrelated lines byte-for-byte, idempotency, secret redaction). No apiKey value appears in any list/probe/test output.
- **R07 (Oracle ensure wiring)**: Proven. install.ps1:288 runs oracle-model ensure --probe after config.yml; run D:/ohmypi/tools/audit.ps1 -> 10/10 clean incl. 'oracle model role PASS oracle=nullform-gateway/gemini-3.8-flash-high'.
- **R08 (No regressions)**: Proven. node --test tools/tests/*.test.mjs 69/69; python tools/tests/test_session_cost.py 8/8; tests/test-portability.ps1 11/11; verify.ps1 26/26 (harness); audit.ps1 10/10 clean incl. prompt-cache baseline PASS (baseline refreshed 2026-09-20T04:53 with media-context and new agent hashes). sync shipped oracle-model/context-inbox/domain-context .mjs + oracle-priority and media-context skill.

## Deliverable files
- openspec/changes/context-pipeline/oracle.md (this file)
