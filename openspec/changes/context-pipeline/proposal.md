# Why
Two approved streams: (1) context intake — the model must be able to ASK for missing context and the user must have one obvious place to drop it; (2) oracle model autoselect — strongest available model for blind acceptance, fallback gemini-3.8-flash-high. Plus P0/P1 from the harness video (domain-context, media-context, human-plan, Ponytail lens).

## What Changes
- context/ convention + context-inbox tool + agent rules.
- domain-context collector (repo + git + gh, all graceful).
- media-context skill (local transcription pipeline).
- oracle-model tool (priority list, declared+discovery availability, targeted config write).
- Prompt rules: CONTEXT-GAPS, human plan, Ponytail lens, oracle ensure wiring.

## Impact
Three disjoint workers; new tools synced; install/audit touched by one owner; baseline refreshed deliberately.
