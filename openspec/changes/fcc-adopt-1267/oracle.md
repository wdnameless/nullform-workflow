# Oracle Acceptance: fcc-adopt-1267

## Blind Acceptance Context
- Change: `openspec/changes/fcc-adopt-1267`
- Branch: `feat/fcc-matrix-doctor-effort`
- Commit: `ff7a257` (following fix round 1 on R01 activation gap)
- Manifest: `openspec/changes/fcc-adopt-1267/manifest.md` (criticality: supporting)
- Acceptance Mode: Wave 4 Blind Acceptance against Requirements Manifest R01–R04 and observable product runtime.

---

## Observable Acceptance Checks (A1–A4) & Receipts

### A1: Harness Matrix Versions/Activation, Probe Verdicts, Schema Test & Live Probe
- **Matrix versions & activation check**:
  Command:
  ```bash
  node -e "const m = JSON.parse(require('fs').readFileSync('tools/harness-matrix.json', 'utf8')).filter(x => x.id); console.log(JSON.stringify(m.map(e => ({ id: e.id, versions: e.versions, activation: e.activation })), null, 2));"
  ```
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```json
[
  {
    "id": "claude"
  },
  {
    "id": "codex"
  },
  {
    "id": "opencode"
  },
  {
    "id": "cursor"
  },
  {
    "id": "omp"
  },
  {
    "id": "openclaw"
  },
  {
    "id": "hermes",
    "versions": {
      "min": "0.20.4",
      "args": [
        "--version"
      ]
    },
    "activation": {
      "args": [
        "config",
        "get",
        "model.provider",
        "--json"
      ],
      "expect": "contains"
    }
  },
  {
    "id": "openhuman"
  },
  {
    "id": "custom"
  }
]
  ```
  (Exit 0)
  Finding: `hermes` carries both `versions: { min: "0.20.4", args: ["--version"] }` and `activation: { args: ["config", "get", "model.provider", "--json"], expect: "contains" }`.

- **probeHarness unit tests (including activation check pass/fail/skip)**:
  Command: `node --test tools/tests/harness-probe.test.mjs`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
✔ satisfiesMin correctly evaluates semver triples without deps (0.9015ms)
✔ probeHarness fixture: installed + version (0.244ms)
✔ probeHarness fixture: not_installed (ENOENT or missing cmd) (0.1379ms)
✔ probeHarness fixture: timeout (0.1283ms)
✔ probeHarness fixture: bad-version (unrecognized semver) (0.1902ms)
✔ probeHarness fixture: execution failed without version (0.1253ms)
✔ probeHarness fixture: min version pass and fail (0.1776ms)
✔ probeHarness fixture: activation check pass/fail/skip (0.3159ms)
✔ defaultRunner handles non-existent binary without uncaught exception (2.4577ms)
✔ doctor --report output shape and secret sweep (5.8237ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 124.9703
  ```
  (Exit 0)

- **Live probe on host machine (verifying activated: true)**:
  Command:
  ```bash
  node -e "const { probeHarness } = require('./tools/harness-probe.mjs'); const matrix = JSON.parse(require('fs').readFileSync('tools/harness-matrix.json', 'utf8')).filter(e => e.id && e.detect?.cmd); console.log(JSON.stringify(matrix.map(e => probeHarness(e)), null, 2));"
  ```
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```json
[
  {
    "id": "claude",
    "installed": true,
    "version": "2.1.251",
    "status": "available",
    "compatible": true
  },
  {
    "id": "codex",
    "installed": false,
    "version": null,
    "status": "not_installed",
    "compatible": false
  },
  {
    "id": "opencode",
    "installed": false,
    "version": null,
    "status": "not_installed",
    "compatible": false
  },
  {
    "id": "cursor",
    "installed": false,
    "version": null,
    "status": "not_installed",
    "compatible": false
  },
  {
    "id": "omp",
    "installed": true,
    "version": "18.13.3",
    "status": "available",
    "compatible": true
  },
  {
    "id": "openclaw",
    "installed": false,
    "version": null,
    "status": "not_installed",
    "compatible": false
  },
  {
    "id": "hermes",
    "installed": true,
    "version": "0.22.5",
    "status": "available",
    "compatible": true,
    "activated": true
  },
  {
    "id": "openhuman",
    "installed": false,
    "version": null,
    "status": "not_installed",
    "compatible": false
  }
]
  ```
  (Exit 0)
  Receipt confirms: `hermes` probe yields `installed: true`, `version: "0.22.5"`, `status: "available"`, `compatible: true`, and `activated: true`.

- **Schema test suite**:
  Command: `node --test tools/tests/init-wizard.test.mjs`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
✔ harness matrix schema, 8+custom entries, MIT attribution, and openhuman unverified (2.1346ms)
✔ matrix fallback when harness-matrix.json is missing or corrupted (0.9915ms)
✔ wizard quick-path: selects harness, quick flow, previews plan, installs all slices (53.4315ms)
✔ wizard advanced-path with slice toggle: custom slices selected and installed (46.9151ms)
✔ wizard back-navigation (..): from flow to harness, and from slices to flow (48.3899ms)
✔ non-TTY / CI defaults: quick+all-slices, print plan, no write without --yes (17.1021ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 296.857
  ```
  (Exit 0)

---

### A2: Doctor --report JSON Shape & Secret Sweep
- **Valid JSON bundle with versions, probes, and activation**:
  Command:
  ```bash
  node -e "const { spawnSync } = require('child_process'); const res = spawnSync('node', ['bin/nullform.mjs', 'doctor', '--report'], { encoding: 'utf8' }); const json = JSON.parse(res.stdout); const hermesProbe = json.report.harnessProbes.find(p => p.id === 'hermes'); console.log('report keys:', Object.keys(json.report).join(', ')); console.log('harnessProbes count:', json.report.harnessProbes.length); console.log('hermes probe:', JSON.stringify(hermesProbe));"
  ```
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
report keys: pkgVersion, system, harnessProbes, configStatus
harnessProbes count: 8
hermes probe: {"id":"hermes","installed":true,"version":"0.22.5","status":"available","compatible":true,"activated":true}
  ```
  (Exit 0)

- **Secret sweep on doctor --report output**:
  Command:
  ```bash
  node -e "const { spawnSync } = require('child_process'); const res = spawnSync('node', ['bin/nullform.mjs', 'doctor', '--report'], { encoding: 'utf8' }); const raw = res.stdout; const secrets = [/sk-[a-zA-Z0-9_-]{20,}/, /ghp_[a-zA-Z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /bearer\s+[a-zA-Z0-9._-]+/i]; let found = 0; for (const s of secrets) { if (s.test(raw)) found++; } console.log('Secret count found:', found);"
  ```
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
Secret count found: 0
  ```
  (Exit 0)

---

### A3: CONTEXT Effort Term & models.yml.example Efforts Agreement
- **CONTEXT Effort term**:
  File: `CONTEXT.md:239`
  Verbatim:
  ```text
- **Effort** — reasoning depth vocabulary: none|low|medium|high|xhigh|max (default medium).
  ```

- **models.yml.example efforts list**:
  File: `agent/models.yml.example:41-43`
  Verbatim:
  ```yaml
          mode: effort
          efforts: [none, low, medium, high, xhigh, max]
          defaultLevel: medium
  ```
  Finding: Both agree on vocabulary `[none, low, medium, high, xhigh, max]` with default `medium`.

---

### A4: Compatibility Facts & Source References
- **Hermes entry**:
  File: `tools/harness-matrix.json:143-162`
  Verbatim:
  ```json
    "versions": {
      "min": "0.20.4",
      "args": [
        "--version"
      ]
    },
...
    "notes": [
      "HERMES_MANAGED_DIR overlay (FCC hermes.py)",
      "source: free-claude-code cli/launchers/hermes.py"
    ],
  ```

- **Codex entry**:
  File: `tools/harness-matrix.json:45-48`
  Verbatim:
  ```json
    "notes": [
      "native catalog path (FCC codex_model_catalog.py)",
      "source: free-claude-code harnesses/codex_model_catalog.py"
    ],
  ```

- **Test validation**:
  File: `tools/tests/init-wizard.test.mjs:83-90` asserts minVersion 0.20.4 and notes for hermes (MANAGED_DIR) and codex (catalog).

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

2. **Quality (COCO Ratchet)**:
   Command: `node tools/quality.mjs check --stack node`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
  node     pass (231 functions)
COCO ratchet clean.
   ```
   (Exit 0)

3. **Code-size gate**:
   Command: `node tools/code-size.mjs check`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
  [EXEMPT] tools/code-size.mjs (731 строк) — defer marker in header
  [EXEMPT] tools/dashboard-ui.mjs (1593 строк) — defer marker in header
  [EXEMPT] tools/quality.mjs (796 строк) — defer marker in header
  [EXEMPT] tools/workflow.mjs (2216 строк) — defer marker in header
code-size: PASS — нарушений нет (4 exempt). Проверено 284 файлов, 1971 функций.
   ```
   (Exit 0)

4. **Agent lint**:
   Command: `node tools/agent-lint.mjs --check`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
agent-lint: 8 agent(s) clean
   ```
   (Exit 0)

5. **Deep Module Quality Gate & Seam Check**:
   `tools/harness-probe.mjs` cleanly encapsulates version probing, timeout, semver validation, and activation probing. Injected runner seam verified across all 10 unit tests.

6. **Vocabulary Drift Gate**:
   `CONTEXT.md:239` introduces canonical `Effort` vocabulary agreeing with configuration.

7. **ADR Conflict Gate**:
   No conflict with existing ADRs (`docs/adr/0001-mutation-lines-scope.md`).

8. **Network Path Gate**:
   No network paths added or modified.

---

## Manifest Requirements Verdicts

| ID | Requirement | Verdict | Grounding & Observable Proof |
|----|-------------|---------|------------------------------|
| R01 | Матрица харнессов несёт версии и проверки (minVersion/args/activation), probe проверяет установленное | **proven** | `tools/harness-matrix.json` carries `versions` and `activation` on hermes. `tools/harness-probe.mjs` checks installed, version, status, and activation. 10/10 unit tests pass in `tools/tests/harness-probe.test.mjs`. Live probe on host confirms hermes: installed true, version 0.22.5, status available, activated true. |
| R02 | `nullform doctor --report` выдаёт shareable JSON-бандл без секретов | **proven** | `node bin/nullform.mjs doctor --report` emits valid JSON with 8 harness probes (including hermes activated:true) and passes negative secret sweep (0 credentials/tokens). Unit tested in `tools/tests/harness-probe.test.mjs`. |
| R03 | Словарь effort канонизирован (none/low/medium/high/xhigh/max, default medium) в CONTEXT + models.yml | **proven** | `CONTEXT.md:239` defines canonical Effort vocabulary; `agent/models.yml.example:41-43` configures matching efforts list and defaultLevel: medium. |
| R04 | Факты совместимости (Hermes ≥0.20.4, MANAGED_DIR, codex catalog) закодированы в matrix со ссылкой на источник | **proven** | `tools/harness-matrix.json` encodes hermes min 0.20.4 + MANAGED_DIR note + FCC launcher ref, and codex catalog note + FCC model catalog ref. Asserted in `tools/tests/init-wizard.test.mjs:83-90`. |

---

## Binary Verdict

Verdict: **ACCEPT**

All requirements R01–R04 are verified as **proven** with executable commands and raw receipts. The R01 activation gap identified in Round 1 is resolved in commit ff7a257 (matrix entry carries activation, probeHarness verdicts activation, 10/10 unit tests pass, live host probe reports activated: true). All quality gates pass clean.
