# Requirements — workflow audit round two

User: «Присутпай к фиксам». This refers to the immediately preceding full audit. Earlier user decision to defer key rotation remains in force; do not read, edit or copy credential files.

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «Присутпай к фиксам» (audit: old dashboard) | An old health protocol is not reused; verified legacy process is retired; HTTP responses use the metadata-only implementation. | in-spec |
| R02 | «Присутпай к фиксам» (audit: CI directory skip) | T2/T3 CI fails if no existing change is validated, including deleted paths and names containing spaces. | in-spec |
| R03 | «Присутпай к фиксам» (audit: verdict freshness) | Only an explicit positive verdict is accepted; subsequent manifest/spec/interface changes invalidate it. | in-spec |
| R04 | «Присутпай к фиксам» (audit: external symlink) | Artifact real paths must stay inside the project; external symlink files/directories fail. | in-spec |
| R05 | «Присутпай к фиксам» (audit: tier escalation) | T1→T2 preserves task identity, start time and compatible artifacts; replacement is explicit. | in-spec |
| R06 | «Присутпай к фиксам» (audit: concurrent state) | Concurrent start/artifact/close operations cannot silently overwrite each other. | in-spec |
| R07 | «Присутпай к фиксам» (audit: Paseo config write) | Interrupted profile update leaves valid old/new JSON and preserves unrelated settings. | in-spec |
| R08 | «Присутпай к фиксам» (audit: missing metric) | Crash between close state and metric publication recovers exactly one terminal record. | in-spec |
| R09 | «Присутпай к фиксам» (audit: false staleness) | Timestamp-only touch with identical content does not invalidate acceptance. | in-spec |
| R10 | «Присутпай к фиксам» (audit: self-declared PR tier) | T0 label cannot pass a PR exceeding its 1–2-file boundary without approved override. | in-spec |
| R11 | «Присутпай к фиксам» (audit: prompt/worker contract) | Active OMP/Paseo instructions agree; an actual invalid worker return is rejected before reconciliation, not just fixture text. | in-spec |
| R12 | «Присутпай к фиксам» (audit: skill parity) | Missing skill comparison root cannot report green; sync/verification makes skills parity visible. | in-spec |
| R13 | «Присутпай к фиксам» (audit: portable docs) | README claims match verified adapters, current suite count, and executable T1 quickstart. | in-spec |
| R14 | «Присутпай к фиксам» (audit: Hindsight timeout) | An unavailable memory service cannot block progress or create a fabricated recall claim. | in-spec |
| R15 | «Присутпай к фиксам» (audit: dashboard Host) | Unexpected Host is refused on every HTTP route; localhost continues to work. | in-spec |
| R16 | «Присутпай к фиксам» (audit: plugin version) | A required pinned plugin with unknown installed version fails doctor; optional remains a warning. | in-spec |

No dependency, database, provider or key migration is requested.
