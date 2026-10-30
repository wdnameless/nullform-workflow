# Oracle Acceptance: omh-model-routing

## Blind Acceptance Context
- Change: `openspec/changes/omh-model-routing`
- Branch: `feat/omh-model-routing`
- Commit: `dffecfe`
- Manifest: `openspec/changes/omh-model-routing/manifest.md` (criticality: supporting)
- Acceptance Mode: Wave 4 Blind Acceptance against Requirements Manifest R01–R04 (A1–A4) and observable product runtime.

---

## Observable Acceptance Checks (A1–A4) & Receipts

### A1 (R01): 4 model categories & fallback chain resolution
- **Requirement R01**: "4 категории моделей под роли (strict/builder/scout + fallback-chain), модели выбирает юзер в настройках"
- **Verbatim user quote**: "модели должен выбирать юзер в настройках"
- **Acceptance A1**: "models.yml поддерживает categories{strict,builder,scout + chain,effort}; недоступная модель = стоп-вопрос, не подмена (тест)."

- **File claims**:
  1. `agent/models.yml.example:46-55`:
  ```yaml
categories:
  strict:
    chain: [my-provider/__DEFAULT_MODEL_ID__]
    effort: high
  builder:
    chain: [my-provider/__DEFAULT_MODEL_ID__]
    effort: medium
  scout:
    chain: [my-provider/__DEFAULT_MODEL_ID__]
    effort: low
  ```

  2. `tools/model-router.mjs:31-47`:
  ```javascript
export const ROLE_TO_CATEGORY = Object.freeze({
  oracle: "strict",
  reviewer: "strict",
  orchestrator: "strict",
  fixer: "builder",
  designer: "builder",
  explorer: "scout",
  scout: "scout",
  sonic: "scout",
  librarian: "scout",
});

export const DEFAULT_EFFORTS = Object.freeze({
  strict: "high",
  builder: "medium",
  scout: "low",
});
  ```

  3. `tools/model-router.mjs:212-246`:
  ```javascript
export function resolveCategory(category, modelsYml, options = {}) {
  const models = loadModelsConfig(modelsYml);
  const targetCategory = ROLE_TO_CATEGORY[category] || category;

  const categories = models.categories;
  if (!categories || typeof categories !== "object") {
    throw new ModelStopQuestionError(MODEL_STOP_QUESTION, {
      category: targetCategory,
      reason: "No categories defined in models configuration",
    });
  }

  const catConfig = categories[targetCategory] || categories[category];
  if (!catConfig || !Array.isArray(catConfig.chain) || catConfig.chain.length === 0) {
    throw new ModelStopQuestionError(MODEL_STOP_QUESTION, {
      category: targetCategory,
      reason: `Chain for category '${targetCategory}' is empty or missing`,
    });
  }

  for (const rawItem of catConfig.chain) {
    const { provider, model } = parseChainItem(rawItem);
    if (!provider || !model) continue;

    if (isModelAvailable(provider, model, models, options)) {
      const effort = catConfig.effort || DEFAULT_EFFORTS[targetCategory] || "medium";
      return { provider, model, effort };
    }
  }

  throw new ModelStopQuestionError(MODEL_STOP_QUESTION, {
    category: targetCategory,
    reason: `All models in chain for category '${targetCategory}' are unavailable`,
  });
}
  ```

- **Execution command (resolveCategory normal walk + exhaustion throw + empty throw)**:
  Command: `node -e "import('./tools/model-router.mjs').then(({ resolveCategory, ModelStopQuestionError, MODEL_STOP_QUESTION }) => { const y = 'providers:\n  provA:\n    models:\n      - id: m-slow\n        available: false\n      - id: m-fast\n        available: true\ncategories:\n  strict:\n    chain: [provA/m-slow, provA/m-fast]\n    effort: high\n  empty:\n    chain: []\n'; console.log('RESOLVE_SUCCESS:', JSON.stringify(resolveCategory('oracle', y))); try { resolveCategory('oracle', y, { unavailable: new Set(['provA/m-fast']) }); } catch (err) { console.log('EXHAUSTED_THROW:', err.code, err.message, err instanceof ModelStopQuestionError); } try { resolveCategory('empty', y); } catch (err) { console.log('EMPTY_THROW:', err.code, err.message, err instanceof ModelStopQuestionError); } });"`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
RESOLVE_SUCCESS: {"provider":"provA","model":"m-fast","effort":"high"}
EXHAUSTED_THROW: MODEL_STOP_QUESTION MODEL_STOP_QUESTION true
EMPTY_THROW: MODEL_STOP_QUESTION MODEL_STOP_QUESTION true
  ```
  (Exit 0)

- **Unit test suite for resolveCategory**:
  Command: `node --test --test-name-pattern="resolveCategory" tools/tests/model-router.test.mjs`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
✔ resolveCategory: resolves primary model and respects role mappings (1.8039ms)
✔ resolveCategory: walks chain, skips unavailable models, stops on exhaustion without silent substitution (0.7398ms)
✔ resolveCategory: throws MODEL_STOP_QUESTION on empty chain or missing category (0.2537ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 107.2931
  ```
  (Exit 0)

---

### A2 (R02): Autorouter scan, plan, and guarded apply
- **Requirement R02**: "Автороутер: по кнопке сканирует провайдеры юзера и назначает модели на роли сам, план только с аппрувом"
- **Verbatim user quote**: "агент бы просканировал доступные юзеру провайдеры и назначит модели на роли сам"
- **Acceptance A2**: "`model-router --scan` находит провайдеры; `--plan` печатает назначения; без аппрува ничего не пишется; с аппрувом — пишется (тест на фикстурах)."

- **File claims**:
  1. `tools/model-router.mjs:390-402`:
  ```javascript
  const rawContent = readFileSync(modelsPath, "utf8");
  const doc = yaml.parseDocument(rawContent, { keepSourceTokens: true });
  if (doc.errors && doc.errors.length > 0) {
    throw new Error(`YAML syntax error in ${modelsPath}: ${doc.errors[0].message}`);
  }

  const finalPlan = plan || await planCategories(rawContent, { probeResults, probeRunner });
  doc.set("categories", finalPlan);

  const updatedContent = doc.toString();
  writeFileSync(modelsPath, updatedContent, "utf8");
  return { ok: true, plan: finalPlan, path: modelsPath };
  ```

  2. `tools/model-router.mjs:472-484`:
  ```javascript
  if (!args.yes) {
    console.error("Refused: --apply requires --yes for explicit approval.");
    return 1;
  }
  const plan = await computePlan(modelsPath, args, probeResults);
  const result = await applyCategories(modelsPath, {
    yes: true,
    plan,
  });
  console.log(`Successfully applied categories to ${result.path}:
`);
  console.log(yaml.stringify({ categories: result.plan }));
  return 0;
  ```

- **Execution command (CLI scan, plan, apply without --yes refusal, apply with --yes write on fixture)**:
  Command: `node -e "const fs = require('node:fs'); const cp = require('node:child_process'); const os = require('node:os'); const path = require('node:path'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-test-')); const modelsPath = path.join(tmp, 'models.yml'); const probePath = path.join(tmp, 'probe.json'); const initialModels = 'providers:\n  prov1:\n    baseUrl: https://api.mock.test/v1\n    models:\n      - id: gpt-4o-mini\n      - id: claude-3-5-sonnet\n      - id: o1-preview\n'; fs.writeFileSync(modelsPath, initialModels, 'utf8'); fs.writeFileSync(probePath, JSON.stringify({ prov1: ['gpt-4o-mini', 'claude-3-5-sonnet', 'o1-preview'] }), 'utf8'); const scanRes = cp.spawnSync(process.execPath, ['tools/model-router.mjs', '--scan', '--models', modelsPath, '--probe-file', probePath], { encoding: 'utf8' }); console.log('--- SCAN (code: ' + scanRes.status + ') ---'); console.log(scanRes.stdout.trim()); const planRes = cp.spawnSync(process.execPath, ['tools/model-router.mjs', '--plan', '--models', modelsPath, '--probe-file', probePath], { encoding: 'utf8' }); console.log('--- PLAN (code: ' + planRes.status + ') ---'); console.log(planRes.stdout.trim()); console.log('BYTE_IDENTICAL_AFTER_PLAN:', fs.readFileSync(modelsPath, 'utf8') === initialModels); const applyNoYesRes = cp.spawnSync(process.execPath, ['tools/model-router.mjs', '--apply', '--models', modelsPath, '--probe-file', probePath], { encoding: 'utf8' }); console.log('--- APPLY WITHOUT YES (code: ' + applyNoYesRes.status + ') ---'); console.log('stderr:', applyNoYesRes.stderr.trim()); console.log('BYTE_IDENTICAL_AFTER_REFUSE:', fs.readFileSync(modelsPath, 'utf8') === initialModels); const applyYesRes = cp.spawnSync(process.execPath, ['tools/model-router.mjs', '--apply', '--yes', '--models', modelsPath, '--probe-file', probePath], { encoding: 'utf8' }); console.log('--- APPLY WITH YES (code: ' + applyYesRes.status + ') ---'); console.log(applyYesRes.stdout.trim()); console.log('WRITTEN_CATEGORIES_IN_FILE:', fs.readFileSync(modelsPath, 'utf8').includes('categories:')); fs.rmSync(tmp, { recursive: true, force: true });"`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
--- SCAN (code: 0) ---
{
  "prov1": [
    "gpt-4o-mini",
    "claude-3-5-sonnet",
    "o1-preview"
  ]
}
--- PLAN (code: 0) ---
categories:
  strict:
    chain:
      - prov1/gpt-4o-mini
      - prov1/claude-3-5-sonnet
      - prov1/o1-preview
    effort: high
  builder:
    chain:
      - prov1/claude-3-5-sonnet
      - prov1/o1-preview
      - prov1/gpt-4o-mini
    effort: medium
  scout:
    chain:
      - prov1/gpt-4o-mini
      - prov1/claude-3-5-sonnet
      - prov1/o1-preview
    effort: low
BYTE_IDENTICAL_AFTER_PLAN: true
--- APPLY WITHOUT YES (code: 1) ---
stderr: Refused: --apply requires --yes for explicit approval.
BYTE_IDENTICAL_AFTER_REFUSE: true
--- APPLY WITH YES (code: 0) ---
Successfully applied categories to D:\TMP\mr-test-77lIO1\models.yml:

categories:
  strict:
    chain:
      - prov1/gpt-4o-mini
      - prov1/claude-3-5-sonnet
      - prov1/o1-preview
    effort: high
  builder:
    chain:
      - prov1/claude-3-5-sonnet
      - prov1/o1-preview
      - prov1/gpt-4o-mini
    effort: medium
  scout:
    chain:
      - prov1/gpt-4o-mini
      - prov1/claude-3-5-sonnet
      - prov1/o1-preview
    effort: low
WRITTEN_CATEGORIES_IN_FILE: true
  ```
  (Exit 0)

- **Unit test suite for scan, plan, apply CLI commands**:
  Command: `node --test --test-name-pattern="CLI: --plan|CLI: --apply|scanProviders|planCategories" tools/tests/model-router.test.mjs`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
✔ scanProviders: returns JSON {provider: [ids] | error} using mock probe runner (1.7556ms)
✔ planCategories: heuristic assigns primary and builds chain [primary, ...rest] with canonical efforts (0.7826ms)
✔ planCategories: works with probe results fixture (0.3162ms)
✔ CLI: --plan prints plan without writing to models.yml (file byte-identical) (191.393ms)
✔ CLI: --apply without --yes refuses and leaves models.yml byte-identical (105.5822ms)
✔ CLI: --apply with --yes writes categories and preserves comments and map-form (116.3716ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 835.2777
  ```
  (Exit 0)

---

### A3 (R03): Reported vs verified run-state & close gate
- **Requirement R03**: "Двучастный статус reported/verified + жёсткий гейт на close"
- **Verbatim user quote**: "T1 recon rule 5 (Wave 0: с гейтом)"
- **Acceptance A3**: "run-state показывает reported vs verified; close при reported-only отказывает без --force --reason (тест)."

- **File claims**:
  1. `tools/workflow.mjs:2020-2034`:
  ```javascript
function checkStageState(root, st, flags) {
  const unverifiedStages = getReportedStages(st);
  if (!unverifiedStages.length) return { ok: true, unverifiedStages: [] };
  if (!flags.force) {
    console.error(`workflow: cannot close ${st.tier} — reported-but-unverified: ${unverifiedStages.join(", ")}.`);
    console.error(`  verify stages with passing oracle/gates, or close with --force --reason "<why unverified stages are accepted>".`);
    logEvent(root, "reported-but-unverified", `${st.tier} — ${st.task} (${unverifiedStages.join(", ")})`);
    return { ok: false, exitCode: 1, unverifiedStages };
  }
  if (!flags.reason) {
    console.error(`workflow: --force requires --reason "<why unverified stages are accepted>"`);
    return { ok: false, exitCode: 1, unverifiedStages };
  }
  return { ok: true, unverifiedStages };
}
  ```

  2. `tools/workflow.mjs:2191-2212`:
  ```javascript
  const stageCheck = checkStageState(root, st, flags);
  if (!stageCheck.ok) return stageCheck.exitCode;

  st.status = "closed";
  st.closedAt = new Date().toISOString();
  if (flags["diff-lines"] !== undefined) {
    st.diffLines = Number(flags["diff-lines"]);
  }
  const deviationText = applyCloseDeviation(st, flags, {
    missing,
    invalid,
    staleAcceptance,
    unverifiedStages: stageCheck.unverifiedStages,
  });
  if (deviationText) {
    logEvent(root, "close", `${st.tier} — ${st.task} (force: ${flags.reason})`, { forced: true });
    console.log(`workflow: closed with DEVIATION — ${deviationText} (${flags.reason})`);
  } else {
  ```

- **Execution command (All 3 close-gate cases: 1) reported-only fails naming stage; 2) verified closes clean; 3) force without reason fails, force with reason writes deviation with unverifiedStages)**:
  Command: `node -e "import('./tools/workflow.mjs').then(({ cmdStart, cmdArtifact, cmdClose, recordStage, setStageVerified, load }) => { const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-oracle-check-')); try { cmdStart(root, { tier: 'T1', task: 'test-close-gate' }); cmdArtifact(root, { kind: 'recon', detail: 'Files: tools/a.mjs; acceptance: node --test passes' }); recordStage(root, 'quality', { status: 'done', verified: false }); const close1 = cmdClose(root, {}); const st1 = load(root); console.log('CASE 1 (reported-only): close exit code =', close1, ', task status =', st1.status, ', quality verified =', st1.stages.quality.verified); setStageVerified(root, 'quality', true); const close2 = cmdClose(root, {}); const st2 = load(root); console.log('CASE 2 (verified): close exit code =', close2, ', task status =', st2.status, ', quality verified =', st2.stages.quality.verified); const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-oracle-check3-')); cmdStart(root3, { tier: 'T1', task: 'test-force-close' }); cmdArtifact(root3, { kind: 'recon', detail: 'Files: tools/b.mjs; acceptance: node --test passes' }); recordStage(root3, 'quality', { status: 'done', verified: false }); recordStage(root3, 'mutation', { status: 'done', verified: false }); const close3NoReason = cmdClose(root3, { force: true }); console.log('CASE 3 (force without reason): close exit code =', close3NoReason); const close3WithReason = cmdClose(root3, { force: true, reason: 'Approved waiver for unverified quality and mutation' }); const st3 = load(root3); console.log('CASE 3 (force with reason): close exit code =', close3WithReason, ', task status =', st3.status); console.log('DEVIATION:', JSON.stringify(st3.deviation)); fs.rmSync(root3, { recursive: true, force: true }); } finally { fs.rmSync(root, { recursive: true, force: true }); } });"`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
workflow doctor-lite WARN: tools/ directory missing
workflow: T1 task opened — test-close-gate
  budget: 25 tool calls for T1
  this tier further requires 1 artifact(s):
    - recon       recon notes: files touched + acceptance check
workflow: recon recorded — 2/2 for T1
workflow: cannot close T1 — reported-but-unverified: quality.
  verify stages with passing oracle/gates, or close with --force --reason "<why unverified stages are accepted>".
CASE 1 (reported-only): close exit code = 1 , task status = open , quality verified = false
workflow: T1 task closed, all artifacts present.
CASE 2 (verified): close exit code = 0 , task status = closed , quality verified = true
workflow doctor-lite WARN: tools/ directory missing
workflow: T1 task opened — test-force-close
  budget: 25 tool calls for T1
  this tier further requires 1 artifact(s):
    - recon       recon notes: files touched + acceptance check
workflow: recon recorded — 2/2 for T1
workflow: --force requires --reason "<why unverified stages are accepted>"
CASE 3 (force without reason): close exit code = 1
workflow: closed with DEVIATION — unverified quality, mutation (Approved waiver for unverified quality and mutation)
CASE 3 (force with reason): close exit code = 0 , task status = closed
DEVIATION: {"forced":true,"reason":"Approved waiver for unverified quality and mutation","unverifiedStages":["quality","mutation"]}
  ```
  (Exit 0)

- **Workflow gate stage test suite**:
  Command: `node --test --test-name-pattern="reported-only|verified stages|force close on reported-only|oracle ACCEPT sets verified" tools/tests/workflow-gate.test.mjs`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
✔ gate: reported-only stages refuse cmdClose with reported-but-unverified (12720.3615ms)
✔ gate: verified stages allow cmdClose without force (13255.3385ms)
✔ gate: force close on reported-only stages writes deviation with unverifiedStages (10.8242ms)
✔ gate: oracle ACCEPT sets verified true; gate pass sets stage verified true (39132.7698ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 65358.0579
  ```
  (Exit 0)

---

### A4 (R04): Memory cadence decisions & session pack filtering
- **Requirement R04**: "Память: keep/reject/defer с письменным обоснованием"
- **Verbatim user quote**: "T1 recon rule 4"
- **Acceptance A4**: "memory-cadence хранит decision+reason на retain; пакет на сессию собирается с учётом решений (тест)."

- **File claims**:
  1. `tools/memory-cadence.mjs:276-288`:
  ```javascript
export function recordCadenceDecision(statePath = DEFAULT_STATE_PATH, details = {}) {
  const id = details.id != null ? String(details.id).trim() : "";
  if (!id) throw new Error("Decision id is required");
  const decision = details.decision != null ? String(details.decision).trim().toLowerCase() : "";
  if (!["keep", "reject", "defer"].includes(decision)) {
    throw new Error(`Decision must be one of: keep, reject, defer (got: ${JSON.stringify(details.decision)})`);
  }
  const reason = details.reason != null ? String(details.reason).trim() : "";
  if (reason.length < 10) {
    throw new Error(`Decision reason must be at least 10 characters (got: ${reason.length})`);
  }

  const decisionRecord = { id, decision, reason, at: details.at || new Date().toISOString() };
  ```

  2. `tools/memory-cadence.mjs:325-340`:
  ```javascript
export function buildSessionPack(packOrMemories, stateOrPath) {
  if (!packOrMemories) return packOrMemories;
  const decisionsMap = resolveDecisionsMap(stateOrPath);
  const transform = (item) => {
    if (!item) return { include: true, item };
    const id = item.id != null ? String(item.id) : (item._id != null ? String(item._id) : null);
    const dec = id ? decisionsMap.get(id) : null;
    if (!dec) return { include: true, item };
    const d = String(dec.decision || "").toLowerCase();
    if (d === "reject") return { include: false, item: null };
    if (d === "defer" && typeof item === "object") {
      return { include: true, item: { ...item, deferred: true, ...(dec.reason ? { deferReason: dec.reason } : {}) } };
    }
    return { include: true, item };
  };
  const filterList = (arr) => arr.map(transform).filter((r) => r.include).map((r) => r.item);
  ```

- **Execution command (round-trip record decisions + reason length check + session pack exclusion/deferral)**:
  Command: `node -e "import('./tools/memory-cadence.mjs').then(({ recordCadenceDecision, buildSessionPack, loadCadenceState }) => { const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const cp = require('node:child_process'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-test-')); const statePath = path.join(tmp, 'cadence.json'); recordCadenceDecision(statePath, { id: 'mem-1', decision: 'keep', reason: 'Relevant architecture rule' }); recordCadenceDecision(statePath, { id: 'mem-2', decision: 'reject', reason: 'Outdated obsolete requirement' }); recordCadenceDecision(statePath, { id: 'mem-3', decision: 'defer', reason: 'Pending migration next quarter' }); const state = loadCadenceState(statePath); console.log('RECORDED_DECISIONS_COUNT:', state.decisions.length); try { recordCadenceDecision(statePath, { id: 'mem-4', decision: 'keep', reason: 'too short' }); } catch (err) { console.log('SHORT_REASON_ERROR:', err.message); } const cliShort = cp.spawnSync(process.execPath, ['tools/memory-cadence.mjs', '--state', statePath, '--record-decision', '--id', 'mem-5', '--decision', 'keep', '--reason', 'tiny'], { encoding: 'utf8' }); console.log('CLI_SHORT_REASON_EXIT:', cliShort.status, 'STDERR:', cliShort.stderr.trim()); const rawPack = [{ id: 'mem-1', text: 'Important rule' }, { id: 'mem-2', text: 'Obsolete rule' }, { id: 'mem-3', text: 'Postponed item' }, { id: 'mem-99', text: 'Unclassified item' }]; const filteredPack = buildSessionPack(rawPack, statePath); console.log('FILTERED_PACK:', JSON.stringify(filteredPack)); fs.rmSync(tmp, { recursive: true, force: true }); });"`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
RECORDED_DECISIONS_COUNT: 3
SHORT_REASON_ERROR: Decision reason must be at least 10 characters (got: 9)
CLI_SHORT_REASON_EXIT: 2 STDERR: Ошибка: --reason требует не менее 10 символов (получено: "tiny")
FILTERED_PACK: [{"id":"mem-1","text":"Important rule"},{"id":"mem-3","text":"Postponed item","deferred":true,"deferReason":"Pending migration next quarter"},{"id":"mem-99","text":"Unclassified item"}]
  ```
  (Exit 0)

- **Unit test suite for memory-cadence decisions**:
  Command: `node --test --test-name-pattern="recordCadenceDecision|buildSessionPack|CLI: --record-decision" tools/tests/memory-cadence.test.mjs`
  CWD: `D:/ohmypi/workflow-repo`
  Output:
  ```text
✔ recordCadenceDecision: сохраняет решения keep/reject/defer и отклоняет reason < 10 символов (3.8242ms)
✔ buildSessionPack: фильтрует rejected, помечает deferred, сохраняет существующий формат пакета (1.938ms)
✔ CLI: --record-decision сохраняет решение, отклоняет reason < 10 символов с кодом 2 (126.0012ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 199.0587
  ```
  (Exit 0)

---

## Static Quality & Repository Gates

1. **model-router test suite**:
   Command: `node --test tools/tests/model-router.test.mjs`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
✔ exports: ModelStopQuestionError, ROLE_TO_CATEGORY, and DEFAULT_EFFORTS (0.8973ms)
✔ classifyModel: applies heuristic correctly (0.267ms)
✔ resolveCategory: resolves primary model and respects role mappings (0.857ms)
✔ resolveCategory: walks chain, skips unavailable models, stops on exhaustion without silent substitution (0.6371ms)
✔ resolveCategory: throws MODEL_STOP_QUESTION on empty chain or missing category (0.2359ms)
✔ scanProviders: returns JSON {provider: [ids] | error} using mock probe runner (0.7588ms)
✔ planCategories: heuristic assigns primary and builds chain [primary, ...rest] with canonical efforts (0.4926ms)
✔ planCategories: works with probe results fixture (0.2897ms)
✔ CLI: --help exits 0 and displays options (178.0319ms)
✔ CLI: --plan prints plan without writing to models.yml (file byte-identical) (105.1017ms)
✔ CLI: --apply without --yes refuses and leaves models.yml byte-identical (96.9556ms)
✔ CLI: --apply with --yes writes categories and preserves comments and map-form (98.2674ms)
✔ applyCategories programmatic: refuses without yes, writes with yes (6.1585ms)
✔ CLI: --scan with nonexistent models path fails loudly with exit 2 (73.6812ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 714.7833
   ```
   (Exit 0)

2. **memory-cadence test suite**:
   Command: `node --test tools/tests/memory-cadence.test.mjs`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
✔ loadConfig: отсутствующий config.yml возвращает fallback-структуру без исключений (2.5558ms)
✔ loadConfig: валидный config.yml извлекает hindsight и memory.backend (1.3027ms)
✔ loadConfig: поддерживает конфиг в формате JSON (0.9451ms)
✔ checkCadenceStatus: без ревизии -> isOverdue: true и daysSinceReview: null (1.3381ms)
✔ checkCadenceStatus: hindsightConfigured: false если секция hindsight отсутствует (1.0113ms)
✔ recordCadenceReview: запись сохраняется, повторный checkCadenceStatus дает isOverdue: false (2.4788ms)
✔ checkCadenceStatus: старая ревизия (> maxDays) дает isOverdue: true (1.9493ms)
✔ formatCadenceReport: формирует человекочитаемый отчет (0.2838ms)
✔ CLI: --help печатает справку и завершается с кодом 0 (51.1276ms)
✔ CLI: --check при отсутствии ревизии завершается с кодом 1, после --record — с кодом 0 (227.7608ms)
✔ CLI: --json вывод выводит валидный JSON с ожидаемыми полями (42.1541ms)
✔ CLI: неверный --max-days или неизвестный флаг отклоняется с exit 2 (77.6359ms)
✔ CLI: --root переопределяет каталог состояния .workflow (42.9472ms)
✔ recordCadenceDecision: сохраняет решения keep/reject/defer и отклоняет reason < 10 символов (2.0508ms)
✔ buildSessionPack: фильтрует rejected, помечает deferred, сохраняет существующий формат пакета (1.6958ms)
✔ CLI: --record-decision сохраняет решение, отклоняет reason < 10 символов с кодом 2 (122.2874ms)
✔ CLI: неполные параметры для --record-decision отклоняются с кодом 2 (125.5023ms)
ℹ tests 17
ℹ suites 0
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 792.2234
   ```
   (Exit 0)

3. **ESLint on touched files**:
   Command: `npx eslint tools/model-router.mjs tools/memory-cadence.mjs tools/workflow.mjs tools/tests/model-router.test.mjs tools/tests/memory-cadence.test.mjs tools/tests/workflow-gate.test.mjs`
   CWD: `D:/ohmypi/workflow-repo`
   Output: (clean, 0 errors, 0 warnings)
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
   Command: `npx --yes @fission-ai/openspec@1.13.2 validate omh-model-routing --strict`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
npm notice run nullform-workflow@1.3.0 npx
npm notice run openspec validate omh-model-routing --strict
Change 'omh-model-routing' is valid
   ```
   (Exit 0)

6. **Code size**:
   Command: `node tools/code-size.mjs check`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
  [EXEMPT] tools/code-size.mjs (731 строк) — defer marker in header
  [EXEMPT] tools/dashboard-ui.mjs (1593 строк) — defer marker in header
  [EXEMPT] tools/quality.mjs (804 строк) — defer marker in header
  [EXEMPT] tools/workflow.mjs (2389 строк) — defer marker in header
code-size: PASS — нарушений нет (4 exempt). Проверено 287 файлов, 2039 функций.
   ```
   (Exit 0)

7. **Debt ledger scan**:
   Command: `node tools/debt-ledger.mjs scan --check`
   CWD: `D:/ohmypi/workflow-repo`
   Output:
   ```text
22 маркеров, 0 без триггера.
   ```
   (Exit 0)

8. **Deep Module Quality Gate & Seam Check**:
   - `tools/model-router.mjs`: Hides candidate discovery, model heuristics, chain creation, and round-trip YAML AST map-form manipulation behind `resolveCategory`, `scanProviders`, `planCategories`, and `applyCategories`. Seams for provider probing (`probeRunner`) and availability filters (`options.unavailable`, `options.available`, `options.probeCache`) allow 100% offline unit and fixture testing without network dependencies.
   - `tools/memory-cadence.mjs`: Encapsulates config extraction, review logging, decision validation (keep/reject/defer with >=10 char reasons), and session pack transformation behind cohesive functions (`recordCadenceDecision`, `buildSessionPack`).
   - `tools/workflow.mjs`: Encapsulates two-part stage status tracking (`reported` vs `verified`), refusal to close unverified stages, and deviation auditing when forced.

9. **Vocabulary Drift Gate**:
   - Verified against `CONTEXT.md`. Public exports and domain terminology (`ModelStopQuestionError`, `ROLE_TO_CATEGORY`, `DEFAULT_EFFORTS`, categories `strict`, `builder`, `scout`, decisions `keep`, `reject`, `defer`, stage status `reported` and `verified`) match established harness roles and workflow stages. No conflicting synonyms or unrecorded public entities introduced.

10. **ADR Conflict Gate**:
    - Checked `docs/adr/` (single ADR `0001-mutation-lines-scope.md`). No contradiction with existing architectural records.

11. **Network Path Gate**:
    - Ground rules require fixture-only testing without network calls or running servers. Probing logic is injected via `probeRunner` and pre-probed fixtures (`--probe-file`, `--probe-json`), verified offline with zero live network calls.

---

## Manifest Requirements Verdicts

| ID | Requirement | Verdict | Grounding & Observable Proof |
|----|-------------|---------|------------------------------|
| R01 | 4 категории моделей под роли (strict/builder/scout + fallback-chain), модели выбирает юзер в настройках | **proven** | `agent/models.yml.example:46-55` specifies categories {strict, builder, scout} with chains and canonical efforts. `tools/model-router.mjs:resolveCategory` maps roles to categories, traverses fallback chain, skips unavailable models, and throws `ModelStopQuestionError` (`MODEL_STOP_QUESTION`) when chain is exhausted or empty without silent substitution. 14/14 tests pass in `tools/tests/model-router.test.mjs`. |
| R02 | Автороутер: по кнопке сканирует провайдеры юзера и назначает модели на роли сам, план только с аппрувом | **proven** | `tools/model-router.mjs` CLI `--scan` probes providers to JSON; `--plan` outputs assignments without mutating `models.yml` (verified byte-identical); `--apply` refuses without `--yes` (exit 1, byte-identical); `--apply --yes` writes plan to `models.yml` in map-form. 6/6 CLI/plan tests pass. |
| R03 | Двучастный статус reported/verified + жёсткий гейт на close | **proven** | `tools/workflow.mjs` tracks stage `status: 'done'` and `verified: boolean`. `cmdClose` refuses when reported-only stages exist (exit 1, prints `reported-but-unverified: <stages>`), closes cleanly when stages are verified (exit 0), and records `deviation: { forced: true, reason, unverifiedStages }` on `--force --reason`. 4/4 targeted tests pass in `tools/tests/workflow-gate.test.mjs`. |
| R04 | Память: keep/reject/defer с письменным обоснованием | **proven** | `tools/memory-cadence.mjs:recordCadenceDecision` persists keep/reject/defer decisions and strictly rejects reasons < 10 characters (API throws, CLI exits 2). `buildSessionPack` excludes `reject` entries, flags `defer` entries with `deferred: true` and `deferReason`, and retains `keep` items. 17/17 tests pass in `tools/tests/memory-cadence.test.mjs`. |

---

## Binary Verdict

Verdict: **ACCEPT**

All requirements R01–R04 (observable checks A1–A4) are verified as **proven** with executable commands and verbatim raw receipts. All static quality gates, linters, OpenSpec validation, and unit test suites pass clean.
