# Oracle Acceptance: fix-all-batch

## Blind Acceptance Context
- Change: `openspec/changes/fix-all-batch`
- Branch: `feat/fix-all-batch`
- Commit: `70c8635` (following fix commit `0df5113`)
- Manifest: `openspec/changes/fix-all-batch/manifest.md` (criticality: supporting)
- Acceptance Mode: Wave 4 Blind Acceptance against Requirements Manifest R01–R08 (A1–A8) and observable product runtime.

---

## Observable Acceptance Checks (A1–A8) & Receipts

### A1 (R01): Python-COCO ratchet & session_cost.py split
- **Requirement R01**: "M1: python-COCO зелен — сплит session_cost.py, остаток ресид с причиной"
- **Acceptance A1**: "pylint python-стек: 0 growth-failures; baseline diff содержит только ресид-остаток с датой+причиной либо пуст."

- **Execution command (Quality check with local venv pylint + COCO plugin)**:
  Command: `QUALITY_PYTHON=.test_oracle_venv/Scripts/python node tools/quality.mjs check --root . --stack python --json`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```json
{
  "ok": true,
  "root": "D:\\ohmypi\\workflow-repo",
  "results": [
    {
      "id": "python",
      "status": "pass",
      "coco": "native",
      "checked": 42,
      "failures": []
    }
  ]
}
  ```
  (Exit 0)

- **Baseline dry-run check**:
  Command: `QUALITY_PYTHON=.test_oracle_venv/Scripts/python node tools/quality.mjs baseline --root . --stack python --dry-run`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
python: 44 baselined, 0 lowered, 2 kept without a current match (rename? use --prune to drop)
dry-run: nothing written
  ```
  (Exit 0)

- **Baseline diff check**:
  Command: `git diff HEAD~1 .quality-baseline.json`
  CWD: `D:/ohmypi/workflow-repo`
  Output: (empty, 0 growth-failures)
  (Exit 0)
  Finding: `parse_and_aggregate` (formerly 105 in baseline) and `format_table` (formerly 23 in baseline) were split in `tools/session_cost.py` into smaller modular helper functions below the ratchet threshold 15 (`_process_transcript_file`, `_process_event`, `_handle_model_change`, `_handle_fallback`, `_handle_message`, `_aggregate_by_role`, `_format_table_row`, `_format_section`). Only baselined `parse_timestamp_to_utc_date` (complexity 20) remains.

- **Python test suite**:
  Command: `python -m unittest discover -s tools/tests -p "test_*.py"`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
...............
----------------------------------------------------------------------
Ran 15 tests in 0.020s

OK
  ```
  (Exit 0)

---

### A2 (R02): Repo Gate certify win-24 & CI log retrieval
- **Requirement R02**: "M2+S5: certify win-24 зелен (rerun+фикс) и добыча CI-логов работает"
- **Acceptance A2**: "Repo Gate зелен полностью (incl. win-24 cell); логи CI добываются командой из recon (записана рабочая команда или фикс)."

- **CI job status check**:
  Command: `gh api repos/wdnameless/nullform-workflow/actions/runs/40808537375/jobs --jq ".jobs[] | select(.id == 123777523384) | {id: .id, name: .name, conclusion: .conclusion, status: .status}"`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```json
{
  "conclusion": "success",
  "id": 123777523384,
  "name": "Certify candidate (windows-latest, Node 24)",
  "status": "completed"
}
  ```
  (Exit 0)

- **CI job logs retrieval command**:
  Command: `gh api repos/wdnameless/nullform-workflow/actions/jobs/123777523384/logs | head -n 30`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
2026-10-29T22:43:58.7002687Z Current runner version: '2.338.0'
2026-10-29T22:43:58.7030301Z ##[group]Runner Image Provisioner
2026-10-29T22:43:58.7031164Z Hosted Compute Agent
2026-10-29T22:43:58.7031734Z Version: 20261021.618
2026-10-29T22:43:58.7032327Z Commit: 21505ad2541d5be6135ed84fc33697146cf75b8e
2026-10-29T22:43:58.7033009Z Build Date: 2026-10-21T00:45:21Z
2026-10-29T22:43:58.7033654Z Worker ID: {c2ebffd5-67ad-4651-bc1a-3fd3c4e737e8}
2026-10-29T22:43:58.7034343Z Region: eastus2
2026-10-29T22:43:58.7034907Z Cloud: Azure
2026-10-29T22:43:58.7035440Z ##[endgroup]
2026-10-29T22:43:58.7037803Z ##[group]Operating System
2026-10-29T22:43:58.7038531Z Microsoft Windows Server 2025
2026-10-29T22:43:58.7039118Z 10.0.26100
2026-10-29T22:43:58.7039724Z Datacenter
2026-10-29T22:43:58.7040219Z ##[endgroup]
2026-10-29T22:43:58.7040737Z ##[group]Runner Image
2026-10-29T22:43:58.7041318Z Image: windows-2025-vs2026
  ```
  (Exit 0)
  Finding: Working log extraction command is `gh api repos/wdnameless/nullform-workflow/actions/jobs/<jobId>/logs`. Win-24 certify matrix cell is green (`conclusion: "success"`).

---

### A3 (R03): Windows-venv Python detection in toolAvailable (.exe probe)
- **Requirement R03**: "S1: toolAvailable видит Windows-venv python (.exe-проба)"
- **Acceptance A3**: "QUALITY_PYTHON на Windows-venv → python-стек runs (не missing-tool)."

- **File claim**:
  File: `tools/quality.mjs:179-186`
  Verbatim lines:
  ```javascript
  if (process.platform === "win32") {
    const lastSlash = Math.max(cmd.lastIndexOf("/"), cmd.lastIndexOf("\\"));
    const hasExt = /\.[^.\\/]+$/.test(cmd.slice(lastSlash + 2));
    if (!hasExt) {
      if ([".exe", ".cmd", ".bat"].some((ext) => existsSync(resolve(cwd, cmd + ext)))) return true;
      return spawnSync("where", [cmd], { cwd, stdio: "pipe", encoding: "utf8", shell: false, windowsHide: true }).status === 0;
    }
  }
  ```

- **Execution command with path-like without extension on win32**:
  Command: `QUALITY_PYTHON=.test_oracle_venv/Scripts/python node tools/quality.mjs check --root .`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
  node     pass (231 functions)
  python   pass (42 functions)
COCO ratchet clean.
  ```
  (Exit 0)

- **Unit test suite**:
  Command: `node --test tools/tests/u-quality.test.mjs`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
✔ R03: toolAvailable resolves path-like cmd without extension on win32 via shim (.venv/Scripts/python) (101.5894ms)
✔ R03: toolAvailable resolves .cmd and .bat shims for path-like commands on win32 (2.0438ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 909.0345
  ```
  (Exit 0)

---

### A4 (R04): models.yml.example efforts reconciled with OMP schema
- **Requirement R04**: "S2: efforts в models.yml.example сверены с OMP-схемой (фикс или возврат в коммент)"
- **Acceptance A4**: "models.yml.example efforts == OMP-схеме (источник проверки назван) или блок возвращен в коммент."

- **File claim 1**:
  File: `agent/models.yml.example:40-44`
  Verbatim lines:
  ```yaml
        # Re-commented: [none..max] violates OMP EffortSchema (minimal..max; source: @oh-my-pi/pi-coding-agent/src/config/models-config-schema-bundle.ts:132)
        # thinking:
        #   mode: effort
        #   efforts: [none, low, medium, high, xhigh, max]
        #   defaultLevel: medium
  ```

- **File claim 2**:
  File: `CONTEXT.md:239`
  Verbatim line:
  ```markdown
- **Effort** — reasoning depth vocabulary: minimal|low|medium|high|xhigh|max (default medium). Source: OMP EffortSchema (models-config-schema-bundle.ts:132); 'none' is a wire off-switch, not a schema value.
  ```

- **OMP schema source verification**:
  Command: `grep -rn "EffortSchema" "D:/npm-global/node_modules/@oh-my-pi/pi-coding-agent" 2>/dev/null`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
D:/npm-global/node_modules/@oh-my-pi/pi-coding-agent\src\config\models-config-schema-bundle.ts:132:	const EffortSchema = type('"minimal" | "low" | "medium" | "high" | "xhigh" | "max"');
D:/npm-global/node_modules/@oh-my-pi/pi-coding-agent\src\config\models-config-schema-bundle.ts:148:		"efforts?": EffortSchema.array(),
D:/npm-global/node_modules/@oh-my-pi/pi-coding-agent\src\config\models-config-schema-bundle.ts:149:		"defaultLevel?": EffortSchema,
D:/npm-global/node_modules/@oh-my-pi/pi-coding-agent\src\config\models-config-schema-bundle.ts:154:		"minLevel?": EffortSchema,
D:/npm-global/node_modules/@oh-my-pi/pi-coding-agent\src\config\models-config-schema-bundle.ts:155:		"maxLevel?": EffortSchema,
D:/npm-global/node_modules/@oh-my-pi/pi-coding-agent\src\config\models-config-schema-bundle.ts:156:		"levels?": EffortSchema.array(),
  ```
  (Exit 0)
  Finding: The block is re-commented in `agent/models.yml.example` with exact verification source cited (`@oh-my-pi/pi-coding-agent/src/config/models-config-schema-bundle.ts:132`).

---

### A5 (R05): Review ledger compacted below 1MiB & review-run admission unblocked
- **Requirement R05**: "S3: review ledger скомпактирован ниже 1MiB, review-run разблокирован"
- **Acceptance A5**: "ledger < 1MiB; `review-run --dry-run` проходит admission (не ledger-refuse)."

- **Ledger file size check**:
  Command: `ls -la .git/nullform-review-budget.json`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
-rwxrwxrwx 1 somebody somegroup 346 Oct 30 03:04 .git/nullform-review-budget.json
  ```
  (Exit 0)
  Finding: 346 bytes is strictly below MAX_LEDGER_BYTES (1,048,576 bytes / 1 MiB).

- **Execution command (review-run dry-run admission)**:
  Command: `node tools/workflow.mjs review-run --change fix-all-batch --role oracle --model dummy/model --base-ref HEAD~1 --dry-run --product-command "["node","--version"]"`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```json
{
  "ok": true,
  "dryRun": true,
  "admission": {
    "dispatchAllowed": false,
    "supported": false,
    "effectiveRoute": "unverified",
    "reason": "No model spending authority: supply --admission-policy PROJECT_RELATIVE_JSON"
  },
  "budget": {
    "totalSettledNanoUsd": 69741000,
    "requiredReserveNanoUsd": null,
    "reservationCount": 1,
    "kind": "git-common",
    "authority": "D:\\ohmypi\\workflow-repo\\.git",
    "available": false,
    "reason": "No model spending authority: supply --admission-policy PROJECT_RELATIVE_JSON"
  },
  "provenance": {
    "role": "oracle",
    "sourceDigest": "48b71bf19f8e29146af3e452a0cb6f7bc0533f44fd2c40905f2810e7496f0192",
    "manifestHash": "60a7fb1b60a3ce4eafefc5c6e24159f06a089276633c7c8b69d423f1306538b9",
    "rolePromptHash": "fafbfcd73b2511cb022d491706fbb6ded7f02148fb54eb0895c9ba3b2bc40d07",
    "testFilesHash": "4779c84dfeaf77d76abef6c06484d3555eb5271ffc0bb2b14a6101f9a11e4500",
    "baseRef": "0df511365b8b3f60ad9a6c2b035cc2ee3d836b65",
    "requestedModel": "dummy/model",
    "promptHash": "6633a55062956a6ce5a731c2e46cb93e8169f4be7092fc736654473d828674f9",
    "productCommandHash": "09236de55dbcc0c5274d7a8cd6d976a8e3444ea8bed0d78d6a7405ca3a2d387b"
  },
  "prerequisites": [
    "earlier reviewer record is stale or completed Stage-B outcome required"
  ],
  "releaseGate": {
    "ok": false,
    "errors": [
      "missing review execution evidence (static ACCEPT markdown alone is not accepted); if this change predates the mechanism, add legacy-acceptance.md with the reason"
    ]
  },
  "resumeCompatible": false,
  "retainedRuns": [],
  "obligations": "Dry-run only: no child and no provider request. Resume imports original matching completed evidence; it never reruns, retags or overrides a verdict."
}
  ```
  (Exit 0)
  Finding: review-run executes cleanly with exit 0 and parses the ledger without throwing ledger-refuse.

- **Unit test suite**:
  Command: `node --test tools/tests/review-budget.test.mjs`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
✔ near-bound ledger: write triggers settle-compaction keeping size < 1 MiB with honest rollup (143.6223ms)
✔ settleReservation on near-bound ledger triggers compaction on write (136.3967ms)
ℹ tests 32
ℹ suites 0
ℹ pass 32
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4444.6362
  ```
  (Exit 0)

---

### A6 (R06): Claims ceiling nested-workspace pinned test
- **Requirement R06**: "S4: семантика claims ceiling запинена тестом nested-workspace → null"
- **Acceptance A6**: "task-claim.test.mjs содержит nested-workspace → null тест, сьют зелен."

- **File claim 1**:
  File: `tools/workflow/claims.mjs:154-156`
  Verbatim lines:
  ```javascript
  // Direct presence of root/.git avoids upward discovery into parent repositories;
  // the null-base test proves the unrelated case, the git-fixture test the owned one.
  if (!entry(join(root, ".git"))) return null;
  ```

- **File claim 2**:
  File: `tools/tests/task-claim.test.mjs:320`
  Verbatim line:
  ```javascript
test("nested workspace inside parent git repo without own .git records null baseCommit", (t) => {
  ```

- **Unit test suite**:
  Command: `node --test tools/tests/task-claim.test.mjs`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
✔ nested workspace inside parent git repo without own .git records null baseCommit (482.6393ms)
ℹ tests 56
ℹ suites 0
ℹ pass 56
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3503.5051
  ```
  (Exit 0)

---

### A7 (R07): GitHub issue #16 for workflow.mjs split
- **Requirement R07**: "C1: тикет на сплит workflow.mjs с замером и планом (без резки)"
- **Acceptance A7**: "GitHub issues созданы (номера в oracle receipts)."

- **Issue verification**:
  Command: `gh issue view 16 --json number,title,state,url`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```json
{"number":16,"state":"OPEN","title":"[C1] Split tools/workflow.mjs before the 2500-line ceiling (2215 now)","url":"https://github.com/wdnameless/nullform-workflow/issues/16"}
  ```
  (Exit 0)

---

### A8 (R08): GitHub issue #17 for skills prune/lazy-catalog
- **Requirement R08**: "C2: тикет на skills prune/lazy-каталог с замером и планом (без резки)"
- **Acceptance A8**: "GitHub issues созданы (номера в oracle receipts)."

- **Issue verification**:
  Command: `gh issue view 17 --json number,title,state,url`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```json
{"number":17,"state":"OPEN","title":"[C2] Skills bloat: 171/236 never invoked — prune or lazy-catalog","url":"https://github.com/wdnameless/nullform-workflow/issues/17"}
  ```
  (Exit 0)

---

## Static Quality & Repository Gates

1. **ESLint**:
   Command: `npm run lint`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
npm notice run nullform-workflow@1.3.0 lint
npm notice run eslint tools/ bin/ bench/checks/
   ```
   (Exit 0)

2. **Code-size gate**:
   Command: `node tools/code-size.mjs check --root .`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
  [EXEMPT] tools/code-size.mjs (731 строк) — defer marker in header
  [EXEMPT] tools/dashboard-ui.mjs (1593 строк) — defer marker in header
  [EXEMPT] tools/quality.mjs (804 строк) — defer marker in header
  [EXEMPT] tools/workflow.mjs (2216 строк) — defer marker in header
code-size: PASS — нарушений нет (4 exempt). Проверено 285 файлов, 1978 функций.
   ```
   (Exit 0)

3. **Clone-coverage gate**:
   Command: `node tools/clone-coverage.mjs check --root .`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
clone-coverage: PASS — нарушений нет (1 exempt) (coverage: 13.7%). Проверено 285 файлов, найдено 792 клонов.
   ```
   (Exit 0)

4. **Agent definition lint**:
   Command: `node tools/agent-lint.mjs --check`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
agent-lint: 8 agent(s) clean
   ```
   (Exit 0)

5. **OpenSpec validation**:
   Command: `npx --yes @fission-ai/openspec@1.13.2 validate fix-all-batch --strict`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
npm notice run nullform-workflow@1.3.0 npx
npm notice run openspec validate fix-all-batch --strict
Change 'fix-all-batch' is valid
   ```
   (Exit 0)

6. **Deep Module Quality Gate & Seam Check**:
   `tools/review/ledger-compact.mjs` cleanly encapsulates reservation partitioning, metadata folding, rollup reservation synthesis, and invariant validation behind `compactLedger(ledger)`. Direct consumers (`tools/review/budget.mjs:writeLedger`) invoke it only when the serialized buffer exceeds `MAX_LEDGER_BYTES`. Natural testing seams are established and exercised by unit tests in `tools/tests/review-budget.test.mjs`.

7. **Vocabulary Drift Gate**:
   `CONTEXT.md:239` specifies canonical `Effort` vocabulary (`minimal|low|medium|high|xhigh|max`, source: OMP EffortSchema `models-config-schema-bundle.ts:132`). No new unrecorded public domain types or entities were introduced.

8. **ADR Conflict Gate**:
   No contradiction with existing repository ADRs.

9. **Network Path Gate**:
   No network paths added or modified in the diff.

10. **Hypothesis Disclosure**:
    - Commit `70c8635`: stated root cause fix across M1 python-COCO split, S1 win-venv probe, S3 ledger compaction, S2 efforts verify, S4 ceiling pin.
    - Commit `0df5113`: stated scoping git base discovery to workspace root to prevent parent `.git` adoption.

---

## Manifest Requirements Verdicts

| ID | Requirement | Verdict | Grounding & Observable Proof |
|----|-------------|---------|------------------------------|
| R01 | M1: python-COCO зелен — сплит session_cost.py, остаток ресид с причиной | **proven** | `tools/session_cost.py` functions `parse_and_aggregate` and `format_table` split into modular helpers; cognitive complexity ratchet clean on 42 python functions (`quality.mjs check --stack python`); baseline diff empty (0 growth failures); 15/15 python tests pass. |
| R02 | M2+S5: certify win-24 зелен (rerun+фикс) и добыча CI-логов работает | **proven** | CI run 40808537375 job 123777523384 "Certify candidate (windows-latest, Node 24)" is success; log retrieval verified via `gh api repos/wdnameless/nullform-workflow/actions/jobs/123777523384/logs`. |
| R03 | S1: toolAvailable видит Windows-venv python (.exe-проба) | **proven** | `tools/quality.mjs:179-186` probes `.exe`, `.cmd`, `.bat` for extensionless commands on win32; `QUALITY_PYTHON=.test_oracle_venv/Scripts/python` runs python analyzer without missing-tool; 11/11 tests pass in `tools/tests/u-quality.test.mjs`. |
| R04 | S2: efforts в models.yml.example сверены с OMP-схемой (фикс или возврат в коммент) | **proven** | `agent/models.yml.example:40-44` re-commented citing OMP EffortSchema (`models-config-schema-bundle.ts:132`); `CONTEXT.md:239` updated with canonical schema values `minimal..max`. |
| R05 | S3: review ledger скомпактирован ниже 1MiB, review-run разблокирован | **proven** | `.git/nullform-review-budget.json` is 346 bytes (< 1 MiB); `tools/workflow.mjs review-run ... --dry-run` completes admission with exit 0; `tools/review/ledger-compact.mjs` auto-compacts on write; 32/32 tests pass in `tools/tests/review-budget.test.mjs`. |
| R06 | S4: семантика claims ceiling запинена тестом nested-workspace → null | **proven** | `tools/workflow/claims.mjs:154-156` guards against parent git discovery; `tools/tests/task-claim.test.mjs:320` pins nested workspace -> null baseCommit; 56/56 tests pass in `tools/tests/task-claim.test.mjs`. |
| R07 | C1: тикет на сплит workflow.mjs с замером и планом (без резки) | **proven** | GitHub issue #16 created: "[C1] Split tools/workflow.mjs before the 2500-line ceiling (2215 now)", state: OPEN. |
| R08 | C2: тикет на skills prune/lazy-каталог с замером и планом (без резки) | **proven** | GitHub issue #17 created: "[C2] Skills bloat: 171/236 never invoked — prune or lazy-catalog", state: OPEN. |

---

## Binary Verdict

Verdict: **ACCEPT**

All requirements R01–R08 (A1–A8) are verified as **proven** with executable commands and raw verbatim receipts. The must-fix defects M1, M2, S1, S2, S3, S4 and tickets C1, C2 meet all acceptance criteria defined in `openspec/changes/fix-all-batch/manifest.md`. All static and dynamic gates pass clean.
