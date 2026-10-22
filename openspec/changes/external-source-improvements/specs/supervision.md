# supervision spec

## State manifests
- A manifest is a list of `{ id, state, pattern }` rules; states are exactly
  `working | blocked | idle`.
- `classify(manifest, tail)` returns the first matching rule's state, else `idle`.

## Wait barrier
- `waitForState(classifier, want, { timeoutMs })` resolves when the classifier
  reports a wanted state, rejects with `timeout` after `timeoutMs`.
- No polling loop with fixed sleeps in consumers; the barrier owns the wait.
