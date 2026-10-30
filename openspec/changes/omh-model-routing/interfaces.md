# omh-model-routing — interfaces

## T1: categories+router (owner: @fixer)

- models.yml: новая TOP-уровневая секция `categories:` (рядом с providers,
  map-form не ломать):
  `strict: {chain: [<p>/<m>, ...], effort: high}` (роли: oracle, reviewer);
  `builder: {chain, effort: medium}` (fixer, designer);
  `scout: {chain, effort: low}` (explorer, scout, sonic, librarian).
  effort из канона minimal|low|medium|high|xhigh|max.
- `resolveCategory(category, modelsYml)` (model-router.mjs, export):
  идёт по chain, пропускает недоступные (по probe-кэшу или пометке),
  возвращает `{provider, model, effort}`; пустой chain → throw
  `MODEL_STOP_QUESTION` (не подмена — вызыватель спрашивает юзера).
- NEW `tools/model-router.mjs` CLI: `--scan` (probeProvider всех провайдеров
  → JSON {provider: [ids] | error}), `--plan` (эвристика→категории→печать,
  без записи), `--apply --yes` (запись categories в models.yml; без --yes —
  отказ). Импорт probeProvider из oracle-model.mjs (read-only reuse).
  Эвристика plan: id match /flash|mini|lite|haiku/i → scout; reasoning flag
  или /opus|pro|max/i → strict; дефолт → builder; chain = [primary,
  ...остаток провайдера].
- models.yml.example: categories-пример ≤12 строк.
- Тесты: резолв chain/throw, plan на фикстурном probe, apply без --yes
  отказывает + файл не меняется. Фикстуры, без сети.

## T2: status gate (owner: @fixer)

- Stage-state: поле `verified: bool` (дефолт false); выставляют: oracle
  ACCEPT (свою стадию), гейты pass (свои). reported = done && !verified.
- `cmdClose`: reported-only стадии → отказ `reported-but-unverified`
  без --force --reason (текст + код как у budget-гейта); с флагом —
  deviation пишется как обычно.
- Тесты: append в workflow-гейт тесты (reported-only close падает;
  verified закрывается; force пишет deviation).

## T3: memory reasons (owner: @sonic)

- memory-cadence state: decision-запись `{id, decision:
  keep|reject|defer, reason: string(≥10 chars), at}`; `--record-decision
  --id --decision --reason` (или ближайший аналог CLI-стиля файла).
- Сессионный пакет: rejected исключаются, deferred помечаются;
  формат пакета не ломать (аддитивные поля).
- Тесты: decision round-trip + пакет фильтрует rejected.
