# Why
CI template exists but is not applied to this repo; no task metrics exist; archmap-report.mjs is 2392 lines with template-escape bug class.

## What Changes
- .github/workflows/repo-gate.yml: real CI on this repo.
- workflow.mjs metrics.jsonl + metrics command.
- Renderer split: client.js + page.css as real files.

## Impact
Interfaces.md defines ownership and the data-injection marker contract.
