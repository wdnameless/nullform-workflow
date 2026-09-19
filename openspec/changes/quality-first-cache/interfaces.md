# Interfaces and ownership

## Cache metrics — tools/session_cost.py
Existing output preserved. New --cache-report and --json fields per model/day/total:
`cacheReadShare = cacheRead / (input + cacheRead)` (null when denominator zero), warmTurns (cacheRead>0), coldTurns (input>0 and cacheRead=0), zeroUsageTurns, modelSwitches (from model_change events), fallbackChanges. Do not infer provider misses from absent fields. Tests in tools/tests/test_session_cost.py.

## Cache Doctor — tools/cache-doctor.mjs
CLI: `node tools/cache-doctor.mjs [--fingerprint old.json,new.json] <session.jsonl...>`. Output RU text or --json. Event parser reads message.usage, model_change, compaction/summary custom events. Cause codes: model-change, model-fallback, prefix-fingerprint-change, compaction, zero-cache-after-warm, zero-usage-error, unknown. Never changes model/context/files.

## Fingerprint — tools/prompt-lint.mjs
`fingerprint --root . [--json]` canonical ordered JSON: {version, layers:{baseInstructions,agentRoles,rules,skills},combined,files:[{layer,path,sha}]}. readdir results sorted; keys serialized in fixed order. Existing commands unchanged.

## Cache policy — .workflow/cache-policy.json + tools/cache-policy.mjs
Defaults/docs: maxModelsPerTask=2, compactionThreshold=.78, maxInlineToolOutputLines=80, maxInlineSubagentResultLines=25, requireStableToolOrder=true, dynamicContextPlacement=tail. `check --root` hard-fails only prompt-lint scan/fingerprint determinism/return-contract fixture validity. Context/model/output values are ADVISORY warnings only. No model config writes.

## Return contract — tools/return-contract.mjs
`check <file> [--max-lines 25] [--json]`. Sections STATUS, FILES, TESTS, INTERFACES, REQUIREMENTS, CONCERNS/BLOCKERS. FILES entries path/URI only; TESTS contains numeric before→after or explicit not-run(parent-owned); line cap. Exit 1 invalid, 0 valid.

## Ownership
- CacheMetrics worker: session_cost.py, cache-doctor.mjs, Python tests/fixtures.
- PromptSafety worker: prompt-lint.mjs, cache-policy.mjs, return-contract.mjs, .workflow/cache-policy.example.json, Node tests, CI/verify wiring.
- Main: specs, sync manifest, integration, docs/git.
