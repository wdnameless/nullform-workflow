# tools/workflow/

## Responsibility
Durable coordination state for cooperating agents and their isolated execution environments: task leases (claims) and workspace/worktree lifecycle. Deliberately **not** an OS-level filesystem sandbox — `claims.mjs` states this explicitly. The guarantee is cooperative exclusion over shared state, discoverable by any process reading the same workspace root.

## Design Patterns
- **Lease / Claim Registry (Durable Lock File)**: `claimTask`, `releaseTask`, `readClaim` implement short, explicit leases: a claim is written to disk before work starts, read by peers to detect duplication, and released on completion. Staleness is resolved by ownership metadata in the claim record, not by trusting a process.
- **Context Packet (Handoff Payload)**: `contextPacket` packages the bounded context a claiming agent needs, so a peer resumes from the packet instead of re-deriving it from the transcript.
- **Command Adapter**: `runClaimCommand` and `runWorkspaceCommand` expose the primitives as CLI verbs so shell-level agents and tests drive the same code path as in-process callers.
- **Boundary Discovery before Mutation**: both modules resolve the workspace root through `worktree-snapshot.mjs` first — git-common/ceiling discovery happens there, so a claim in a nested worktree lands in the project-level store rather than in an unrelated parent repository.

## Data & Control Flow
1. A caller resolves the workspace root (via `worktree-snapshot.mjs`) and issues a claim verb → `runClaimCommand` → `claimTask`.
2. `claimTask` reads existing claims, refuses on a live conflict, otherwise writes the claim record and returns the lease; `readClaim` is the peer-side read used to detect collisions before spawning.
3. Work proceeds in a workspace prepared by `workspaces.mjs` (`runWorkspaceCommand`) — worktree creation/adoption is delegated to `worktree-snapshot.mjs`, not reimplemented here.
4. On completion or abort, `releaseTask` clears the claim; a crashed owner leaves a stale record that the next reader can identify by its recorded owner/timestamp.
5. `contextPacket` produces the durable handoff payload written alongside the claim.

## Integration Points
- **Imports**: `../worktree-snapshot.mjs` — the single source of workspace-root and git-common discovery for both modules (highest fan-in module in `tools/`, 19 importers).
- **Consumers**: `tools/workflow.mjs` (tier/task lifecycle: `start`, `artifact`, `check`, `close`), `tools/workflow-ci.mjs`, `tools/session-retro.mjs`, and `tools/tests/workflow-*`, `task-claim.test.mjs`.
- **On-disk contract**: coordination records live under the workspace's `.workflow/` state directory alongside `state.json`, `events.jsonl`, `metrics.jsonl`; `tools/lead-time.mjs` consumes `events.jsonl` for tier lead-time and pause medians.
- **CLI surface**: `runClaimCommand`, `runWorkspaceCommand` are the verbs shell-level agents use; in-process callers use `claimTask` / `releaseTask` / `readClaim` / `contextPacket` directly.
- **Known limit**: exclusion is cooperative — a process that never reads the registry is not stopped. Real isolation belongs to the worktree layer, not to this folder.
