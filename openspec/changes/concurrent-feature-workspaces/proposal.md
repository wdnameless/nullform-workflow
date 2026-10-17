# Safe concurrent feature work

## Why

Several agents sharing working files and Git index can overwrite each other even when their intended features differ. Restoring one whole file from a stash is replacement, not integration.

## Change

Use Git's existing worktree isolation behind the public workflow CLI. Each feature receives a private detached working directory based on a recorded commit. Feature results converge on the existing integration branch through a serialized, clean-tree integration operation. A conflict remains visible and recoverable; the tool never restores or resets unrelated work.

Project-owned instructions dispatch writers to the allocated directory, not the integration checkout. The existing OMP guard treats stash-based restoration and working-tree replacement as destructive. No new dependency, scheduler, alternate VCS or claim of universal shell enforcement.

## Acceptance

Run real temporary Git repositories with concurrent allocations, dirty/staged operator files, independent feature commits and conflicting same-file commits. Observe preserved bytes/index/state and explicit conflict/refusal. Verify the installed Node-native CLI and guard behavior; review against manifest quotes, not this proposal.
