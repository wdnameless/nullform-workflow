# Requirements — OMP/Paseo hardening

User: «На ротацию ключа пока забей, все остальное давай фиксить». Key rotation and edits to credentials are out of scope.

| ID | User quote | Acceptance | Status |
|---|---|---|---|
| R02 | «все остальное давай фиксить» (audit item 2) | T2/T3 cannot register required file artifacts without paths; REJECT cannot close; retained evidence is checked at close. | in-spec |
| R03 | «все остальное давай фиксить» (audit item 3) | Edits, additions and deletions after acceptance invalidate it, including untracked source. | in-spec |
| R04 | «все остальное давай фиксить» (audit item 4); selected «Проверяемые артефакты в PR» | CI does not silently skip workflow proof; T2/T3 PRs carry manifest/spec/interfaces/acceptance evidence, with executable validation; T0/T1 remain lean. | in-spec |
| R05 | «все остальное давай фиксить» (audit item 5); selected «Только метаданные» | HTTP dashboard excludes user/assistant/tool-result text, tool arguments, and other sensitive free-form values; only event metadata/status exposed. | in-spec |
| R06 | «все остальное давай фиксить» (audit item 6) | Live and source prompt surfaces use a valid tool path and one checked installation source; no resurrected archmap mandate. | in-spec |
| R07 | «все остальное давай фиксить» (audit item 7) | T1 never mandates Wave 0; T2/T3 interview only for user decisions not settled by sources. | in-spec |
| R08 | «все остальное давай фиксить» (audit item 8) | Clean optional Paseo setup without a model handles omission clearly and cannot abort base install; profile notes have a real path. | in-spec |
| R09 | «все остальное давай фиксить» (audit item 9); selected «Критичные блокируют установку» | Plugin versions are exact; required plugins fail the install/doctor if absent; optional plugins warn. | in-spec |

Confirmation: «Да, приступай». No credential files may be read, copied, edited or printed as part of implementation.
