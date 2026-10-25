# Oracle

Verdict: ACCEPT

Each of the five requirements was verified by an executed check, and each guard was
proven by mutation (removing it fails the corresponding test, restoring it passes):
R01 rename carry-forward, R02 UNVERIFIED default, R03 dirty-worktree refusal.
R04 verified by running the gate on the full 226-file checkout (previously ENAMETOOLONG)
and by the disappearance of 2646 archived-copy findings. R05 verified by the checkout
standing on master@35acc94 with the sibling work preserved in a stash.

The gate flagged this change own code four times; each was decomposed rather than
re-seeded, and the merged tree measures 237 functions with a clean ratchet.
