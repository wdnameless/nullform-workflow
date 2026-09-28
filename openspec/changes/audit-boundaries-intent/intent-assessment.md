# Intent capture: where it fits this workflow

**Decision:** no new mandatory `intent.md` or prompt-template change for direct user-to-agent tasks. Wave 0 already asks unresolved questions, the requirements manifest preserves the user's words, and OpenSpec owns technical design. Making every fix pass through another document would duplicate the manifest without removing a handoff.

The linked video calls `intent.md` a human-corrected proto-spec: problem, desired outcome, affected users/systems, constraints, open questions; implementation details belong to the later spec ([video 01:00–05:40](https://www.youtube.com/watch?v=Vxw9DQjsrHY&t=60s)). A human reviews the file before its Git handoff to design ([06:45–08:00](https://www.youtube.com/watch?v=Vxw9DQjsrHY&t=405s)). This is also the contract in [Claude Academy's Capture as intent.md lesson](https://academy.claude.com/courses/ai-native-sdlc-playbook/capture-intent), not a replacement for rigorous requirements on high-risk changes.

| Existing path | Optional addition when an idea arrives outside the coding chat |
|---|---|
| User talks directly to the agent → Wave 0 → verbatim `manifest.md` → OpenSpec | Non-developer or incident author records a short Git-reviewed `intent/<date>-<slug>.md` **before** Wave 0. |
| Wave 0 resolves questions; G1 retains every quoted requirement | Accepted intent is the quoted source for the same manifest. Open questions must be answered or explicitly carried into G1; no second technical spec. |
| Human approves scope and blind Oracle checks the delivered behavior | Product owner corrects and accepts/rejects the intake PR. The existing Oracle still judges manifest and running artifact, never the intake author's unreviewed draft. |

**Pilot only if needed:** route three asynchronous ideas through one repo-local `intent/` folder using the five lesson sections plus `Out of scope` and `Author / status`; compare them with three direct-chat changes. Track first conversation → committed intent, accepted/closed ratio, and changes to intent after the first spec commit (the lesson's measures). If originators reliably submit through different teams and handoff loss remains measurable, then ask the team to approve a template/skill and merge-triggered automation. Until then, use the current controls and avoid another required CI gate or a separate intent repository. The video itself recommends starting with one repo and a small pilot ([10:00–10:46](https://www.youtube.com/watch?v=Vxw9DQjsrHY&t=600s)).
