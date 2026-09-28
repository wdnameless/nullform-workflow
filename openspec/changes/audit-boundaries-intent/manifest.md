# Requirements — audit boundary remediation and intent review

Source request, verbatim:

> «фикси»
> «https://www.youtube.com/watch?v=Vxw9DQjsrHY»
> «подумай как мы это можем встроить в наш воркфлоу»

The first quote refers to the immediately preceding audit report's seven confirmed issues and its low-priority exact duplicate skill entry. Acceptance below expands those named issues; it does not add unrelated features. The video request asks for a source-grounded integration recommendation, not implementation of a new mandatory stage.

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «фикси» | Sync refuses a manifest source/destination escaping its declared root via file symlink (including dangling targets) or parent junction before changing any file; ordinary in-root deploy/promote/check still work. | in-spec |
| R02 | «фикси» | Promote replaces the actual harness root with `<HARNESS>` when followed by a newline, without altering similar-looking unrelated text or punctuation. | in-spec |
| R03 | «фикси» | Verification with `--user-home` passes that home's `.omp/agent` to sync on Windows and POSIX; unrelated host agent files cannot cause drift. | in-spec |
| R04 | «фикси» | Local T2 check/close and CI reject every explicit REJECT in the current change's oracle evidence, including a second file when `--path` selects an ACCEPT and multi-hyphen names such as `oracle-blind-recheck.md`; a positive `--path` from another change cannot satisfy acceptance. | in-spec |
| R05 | «фикси» | Guarded T0 auto refuses closure when Git status or diff inspection fails in an initialized repository; no out-of-scope edit can bypass its allow-list or diff cap. | in-spec |
| R06 | «фикси» | Generated static dashboard HTML excludes the same sensitive free text as HTTP state; a synthetic task marker is absent from both, while the page renders. | in-spec |
| R07 | «фикси» | `/api/diff` counts lines in an untracked large file with bounded memory and returns metadata only; ordinary tracked/untracked diff behavior remains intact. | in-spec |
| R08 | «фикси» | Remove the byte-identical nested `skills/cro/cro/SKILL.md` entry; the canonical root skill remains registered, with unrelated nested resources untouched. | in-spec |
| R09 | «https://www.youtube.com/watch?v=Vxw9DQjsrHY»; «подумай как мы это можем встроить в наш воркфлоу» | Deliver a recommendation grounded in the video's `intent.md` capture process, the primary Claude Academy lesson and existing Wave 0/manifest/OpenSpec; distinguish optional intake from a new compulsory gate. | in-spec |
