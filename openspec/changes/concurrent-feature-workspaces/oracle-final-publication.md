# Published-source concurrency acceptance reconciliation

Verdict: ACCEPT

Scope: unchanged concurrent-feature-workspaces implementation within the published `nullform-workflow@1.2.0` program. This is a parent reconciliation of existing executed evidence and the final integration oracle, not a retagged historical native run.

Source digest remains `21e7a3be6c7ebc8ffa26ff93eed18a93abf9b33cca563026b0a79a2057c14c1b`; frozen tests remain `87563665979da14323391c0f01ad3fc44d1126908288e01a9dc69f5a27a80ab9`. Publication archive SHA-256 is `1672edcd65e67e5d4247976b2cbc92b100c2d403fe54cb660efb6bf5ef3fb4ef`.

The independent installed concurrent-feature executions recorded in [oracle.md](oracle.md) and [review-evidence.json](review-evidence.json) remain the slice's actual native evidence: sessions `01a13803-aff6-77b6-a946-655f61c3df25` and `01a13808-787c-747d-946e-132dc0a736b8`, both ACCEPT, actual installed public CLI execution exit0. Their R01–R03 evidence and bounded operating contract are unchanged; no new concurrency run or model usage is invented here.

[Final program acceptance](../portable-product-release/oracle-final-publication.md) adds two independent normal native sessions `01a13f98-6440-7477-8e82-c14c692e9c6a` and `01a13fa7-5737-71a3-8e96-eeb68fdd953f`, both ACCEPT, each verifying that same source/test snapshot, the retained27/27 concurrent-feature tests and a fresh live public registry installation/reapplication. Their original records are in the portable change's review-evidence.json, not duplicated into this slice's events.

Final hosted CI [38497146485](https://github.com/wdnameless/nullform-workflow/actions/runs/38497146485) on41a689c succeeded overall, including both changes' gates and all six identical-archive certificates. This supersedes only the old report's statement that final publication was pending and the cited earlier CI's overall gate was not green; its historical observations and original reports remain unchanged. Local full run788/788,0fail/0skip; hosted Linux788total,778pass,0fail,10skip.

Receipt-only publication integration does not change production source or frozen tests. Acceptance evidence for both slices is committed together so neither slice's Git acceptance epoch silently precedes the other slice's final receipts. No gate exemption or source-hash exclusion was added.

Limits remain: one repository and one final integration branch with private feature worktrees/indexes, not simultaneous writers in one physical checkout; visible Git conflicts and possible semantic conflicts; OMP interception only, guidance/CLI for other adapters; uncertain locks are not automatically evicted. General development-quality benefit remains not-proven.
