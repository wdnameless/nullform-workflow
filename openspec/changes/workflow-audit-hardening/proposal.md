# Why
Local tier checks currently accept unsupported claims, while CI skips the ignored state file. The dashboard exposes session text locally, and optional Paseo/plugin setup can leave the installed workflow inconsistent.

## What changes
- Make recorded acceptance evidence and freshness enforceable, including negative verdicts and new files.
- Require an explicit PR tier and committed evidence for heavy changes; keep small PRs lightweight.
- Limit dashboard HTTP output to metadata.
- Remove contradictory prompt rules and repair Paseo/profile and plugin installation policy.

## Out of scope
Key rotation and changes to credentials, unrelated product functionality, and a new dependency.
