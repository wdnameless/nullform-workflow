# Why
The current workflow can report success without validating any T2/T3 change, accept an unsupported verdict, lose evidence under concurrent writes, and reuse a dashboard still running code from before the privacy fix. Local checks and installed profiles also disagree in several recovery paths.

## What changes
- Make CI and local acceptance reject missing, stale or out-of-project evidence.
- Preserve task state and terminal metrics across escalation, concurrency and interruption.
- Make dashboard and Paseo process/config updates fail safely.
- Align the instructions, skill checks and supported-adapter documentation with observed behavior.

## Out of scope
Key rotation, new providers, new dependencies, and changing product UI design. Retain useful architectural metadata in the dashboard.
