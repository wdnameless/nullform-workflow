# spend-safety spec

## Ledger
- `recordReceipt(ledger, receipt)` is idempotent on `receipt.id`.
- `admit(ledger, tier, cost)` throws when `used[tier] + cost > ceiling[tier]`.
- Ledger persists to disk; reload after restart preserves used/receipts.

## Gatekeeper
- `authorize(tool, args)` returns `{ ok: true }` or `{ ok: false, rule }`.
- Dangerous tools (exec/write/network) require an explicit allow rule; default deny.
- Every decision is appended to an audit log with tool, rule and timestamp.
