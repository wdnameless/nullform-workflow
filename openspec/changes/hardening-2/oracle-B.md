# Oracle B — independent blind acceptance pass — hardening-2

VERDICT: **ACCEPT** — round 1 was REJECT; the two row-level failures (R02, R04) were fixed and independently re-verified in round 2 (§13). Residual disclosures, none of them a row failure, are listed at the end of §13.

Author: HardOracleB (second, independent pass; oracle-A.md was NOT read). Repo under test: `D:/ohmypi/workflow-repo`. Source of truth: `openspec/changes/hardening-2/manifest.md` only. Forbidden and NOT opened: `proposal.md`, `specs/**`, `interfaces.md`, `tasks.md`, `oracle-*.md`.

All commands below were executed with an explicit cwd `D:/ohmypi/workflow-repo` (session dir `D:/ohmypi` is NOT the repo). Shell = `cmd /v:on /c` or `powershell -NoProfile`, launched through the supervised process runner. Exit codes are printed by the command itself (`echo EXIT_X=!errorlevel!`) and quoted as printed.

---

## 1. Row-by-row verdict

| ID | Verdict | Basis |
|---|---|---|
| R01 | PROVEN | oracle.md:22-28 protocol; orchestrator.md:90; AGENTS.md:60 |
| R02 | PROVEN (round 2) | round 1: FAIL — `debt-ledger` false-green on a typo; fixed + regression tests, gate still red on the real finding (§13) |
| R03 | PROVEN | doctor orphan-files check live; `sync.ps1 -Prune` dry-run; shared module + tests |
| R04 | PROVEN (round 2) | round 1: PARTIAL; the registry note now accounts for all 37 with buckets I re-derived independently (15 lock-managed + 17 designer-referenced + 4 paseo-* + 1 media-context) (§13) |
| R05 | PROVEN | README.md:119-122; CONTEXT.md:50-51,115-116 |
| R06 | PROVEN | 8 runs on disk; all four medians recomputed by me match report/compare |
| R07 | PROVEN | node 160/160; python 8 OK; verify 27/27; audit 14 clean; portability 11 passed; doctor 8 pass/0 fail; sizes within budget; baseline 80 surfaces |

---

## 2. R01 — Oracle protocol in the role — PROVEN

`grep -nE "EVIDENCE PROTOCOL|NOT PROVEN|never round|NO PARAPHRASE|CWD DISCIPLINE|NUMBER CONSISTENCY" agent/agents/oracle.md`:

```
22|## EVIDENCE PROTOCOL (mandatory)
24|1. FILE CLAIM → exact path + line number + the verbatim line(s), quoted from a command output. Shape: `agent/agents/oracle.md:35` — `5. A product nobody ran is a hypothesis: ...`. Name the command that produced the quote when it is not obvious.
25|2. BEHAVIOURAL CLAIM → the exact executed command + its raw output, with counts and exit codes AS PRINTED (never rounded, never restated in prose). Shape: `node tools/prompt-lint.mjs scan --root .` → `prompt-lint: no volatile literals in 81 prompt surfaces.` (exit 0).
26|3. CWD DISCIPLINE → run every command with an explicit cwd and state it. The session directory is NOT the repo; a command run from the wrong cwd proves nothing about the repo.
27|4. NO PARAPHRASE → never translate, summarise, or write the output you "expected". Quote raw bytes. If a check cannot run (...), write `NOT PROVEN: <check> — <reason>` and stop; never infer its result.
28|5. NUMBER CONSISTENCY → every summary number MUST appear verbatim in the raw output you quoted.
31|1. READ-ONLY: Never modify files.
```

`agent/agents/orchestrator.md:90` (verbatim, command `read .../orchestrator.md:80-92:raw`):

```
- Wave 4: @oracle blind acceptance & runtime verification — ... **Flash-class → Double Acceptance**: if the resolved model matches `*flash*` or is the configured fallback entry, a single pass is not acceptance — run **two independent oracle passes** and reconcile: ACCEPT requires both to agree; either `REJECT` forces a fix round (then a fresh pair). **Oracle-lite**: a single pass is permitted ONLY when the slice touches ≤2 files and the diff is ≤~80 lines — it follows the same evidence protocol as the full oracle (`agent/agents/oracle.md` § EVIDENCE PROTOCOL); anything larger goes through double acceptance.
```

Weekly memory review line, `agent/AGENTS.md:60` (verbatim from grep):

```
60|- WEEKLY REVIEW (once a week): review the bank — prune stale or superseded memories, fold durable architectural decisions into `docs/adr/`, and keep only what still guides future work.
```

Independently confirmed live: `node tools/oracle-model.mjs list --bogus` printed `Выбранная модель : nullform-gateway/gemini-3.8-flash-high` — flash-class, therefore double acceptance is required, and this pass B is the mandated second pass.

---

## 3. R02 — Tool bug hunt — PARTIAL → FAIL (blocking)

The hunt itself is real: regression tests for the fixed defect class exist and can be red (they assert the NEW strict exit codes, while the source comments record the OLD silent behaviour).

Regression tests (grep, `tools/tests`):

```
usage-audit.test.mjs:293|      [['--day', '30'], /неизвестный параметр --day/],
usage-audit.test.mjs:298|      assert.equal(cli.status, 2, JSON.stringify(args));
domain-context.test.mjs:238|test('domain-context CLI: --max-files 0/-1/abc отклоняются (exit 2), а не подменяются на 15', () => {
domain-context.test.mjs:255|      assert.equal(cli.status, 2, JSON.stringify(args));
prompt-cache.test.mjs:308|test('неизвестная команда завершается кодом 1, а не 0', () => {
prompt-cache.test.mjs:310|  assert.equal(cli.status, 1);
benchmark.test.mjs:639|test("CLI: --runs 0/-1 отклоняется с exit 2, а --runs 1 остаётся валидным", () => {
debt-ledger.test.mjs:378|  const p1 = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", nonExistent], { encoding: "utf8" });
debt-ledger.test.mjs:379|  assert.equal(p1.status, 2);
```

Cause statements recorded in the source (the "hypothesis that turned out correct"):

```
tools/usage-audit.mjs:474|  // Неверный/опечатанный параметр раньше молча менял окно аудита (--day 30 → 30 дней).
tools/benchmark.mjs:1047|    // Молчаливое «0/-1 → 1» раньше превращало --runs 0 в настоящий прогон бенчмарка.
tools/prompt-lint.mjs:559|  // Несуществующий --root раньше молча давал зелёный результат по чужому дереву
```

### BLOCKING FINDING B-1 — `debt-ledger` still false-greens on a mistyped flag (same class as the fixes above)

REPRO (cwd `D:/ohmypi/workflow-repo`, single cmd line, exit codes printed by the shell):

```
> node tools/debt-ledger.mjs scan --check --markr TODO & echo EXIT_B=!errorlevel!
Чисто: отложенных упрощений нет.
EXIT_B=0
> node tools/debt-ledger.mjs scan --check --marker TODO & echo EXIT_C=!errorlevel!
## skills/skill-creator/scripts/init_skill.py
  skills/skill-creator/scripts/init_skill.py:119 — Add actual script logic here | [no-trigger]1 маркеров, 1 без триггера.
EXIT_C=1
```

Same tree, same gate, same intent — one typo (`--markr`) turns a RED debt gate into a GREEN one.

A second instance of the same hole (value-less flag silently falls back to cwd):

```
> node tools/debt-ledger.mjs scan --root & echo EXIT_B=!errorlevel!
Чисто: отложенных упрощений нет.
EXIT_B=0
> node tools/debt-ledger.mjs scan --root Z:/definitely-missing & echo EXIT_A=!errorlevel!
Каталог не найден: Z:/definitely-missing
EXIT_A=2
```

CAUSE (verbatim, `read tools/debt-ledger.mjs:447-476:raw`): the parser keeps only the flags it knows and drops everything else — no unknown-flag and no missing-value validation:

```
    } else if (arg === "--root") {
      args.root = argv[++i];
    } else if (arg.startsWith("--root=")) {
      args.root = arg.slice(7);
...
    } else if (arg === "--write") {
      args.write = argv[++i] ?? "";
...
    } else if (!arg.startsWith("-")) {
      args._.push(arg);
    }
```

Note the asymmetry: `--write` gained a missing-value guard elsewhere in the same file (`Ошибка: --write требует путь к файлу реестра.` / exit 2), and `--root` did not.

FIX OWED: reject unknown/malformed flags in `parseArgs` exactly as `usage-audit.mjs` and `domain-context.mjs` now do (`Ошибка: неизвестный параметр --markr.` + usage + exit 2), plus a regression test of the form `scan --check --markr TODO → exit 2`. This tool is not decorative: `tools/auto-review.mjs` and `verify.ps1` (check `debt ledger gate works  PASS noTrigger=1 ok=0 json=ok`) both lean on it.

---

## 4. R03 — Infra bug hunt + sync prune — PROVEN

`node tools/doctor.mjs --harness D:/ohmypi --json` (installed mode, orphan check ACTIVE), raw excerpt:

```
{
      "id": "orphan-files",
      "status": "warn",
      "detail": "24 файл(ов) харнесса отсутствуют в репозитории — прочие (24): agent/SYSTEM.md, agent/artifact_desktop_final.png, ... agent/audit_artifacts/screen-0ms.png, agent/designer.md, agent/kimi-device-id … (+16)"
  "summary": { "pass": 8, "fail": 0, "warn": 1, "skip": 0 },
  "ok": true
```

`powershell -NoProfile -File tools/sync.ps1 -Prune` → exit 0, raw:

```
prune: 4 candidate(s)
  [X] tools/archmap-analysis.mjs
  [X] tools/archmap-demo.mjs
  [X] tools/archmap-report.mjs
  [X] tools/archmap.mjs
sync: dry-run only - nothing was deleted. Re-run with '-Prune -Confirm' to delete.
```

Independently confirmed that the four candidates really are harness-only files: `glob D:/ohmypi/tools/archmap*.mjs; D:/ohmypi/workflow-repo/tools/archmap*.mjs; C:/Users/Administrator/omp-workflow` returned matches only under `C:/Users/Administrator/omp-workflow/tools/` (archmap-demo.mjs, archmap-analysis.mjs, archmap-report.mjs, archmap.mjs). One source of truth is real: `tools/sync.ps1:133-141` shells out to `tools/sync-prune.mjs`, and `doctor.mjs` imports the same module; `tools/tests/sync-prune.test.mjs` exists (untracked) and passed in the 160/160 run.

Secondary finding (see §7 B-2): `node tools/sync-prune.mjs --harness Z:/nope --repo .` → `prune: 0 candidate(s)` / exit 0, because the guard at `tools/sync-prune.mjs:150-153` checks only presence, never existence.

---

## 5. R04 — Skills disable-list + pruning — PARTIAL

Disable list honored by skills-doctor — `node tools/skills-doctor.mjs --installed C:/Users/Administrator/.agents/skills --repo D:/ohmypi/workflow-repo/skills` → exit 0, raw:

```
skills-doctor: 67 installed, 68 in repo, 1 disabled by operator

  info
    biblicism-extractor: disabled by operator  notes (informational)
    frontend-design-anthropic: declares name 'frontend-design' (directory is 'frontend-design-anthropic')
    industrial-brutalist: declares name 'industrial-brutalist-ui' (directory is 'industrial-brutalist')
  all checks passed (frontmatter, truncation, parity, orphans, names).
```

Installer skip logic proven behaviourally (no PS test covers it; I ran the installer into a throwaway user home with `{"disabled":["deepwork"]}`):

```
  [ok] skills: 67 installed, 1 disabled by operator skipped
INSTALL_EXIT=0
SKILL_DIRS=67
DEEPWORK_PRESENT=False
```

Live `mcp.json` garbage removed — `read C:/Users/Administrator/.omp/agent/mcp.json` contains 9 servers (codebase-index, playwright, chrome-devtools, ast-grep, dap-debugger, codegraph, context7, hindsight, crawl4ai) and no `test-mcp-renamed-2`; the backup exists: `C:/Users/Administrator/.omp/agent/mcp.json.removed.json` = `{ "mcpServers": { "test-mcp-renamed-2": { "command": "echo", "args": [ "hello" ] } } }`. JSON validity is asserted by the tool itself: doctor check `configs` → `Конфигурационные файлы: mcp.json (валидный JSON), models.yml (присутствует), config.yml (присутствует)`.

### MISSING HALF — pruning is 1/37, and the moved skill is not the one the audit flagged

`node tools/usage-audit.mjs --days 90 --json --skills C:/Users/Administrator/.agents/skills --mcp C:/Users/Administrator/.omp/agent/mcp.json` → exit 0, `"unusedSkills"` (37 entries; the JSON array is reprinted on one line, values verbatim):

```
"unusedSkills": [ 
    "animate-expo", "animation-vocabulary", "banner-design", "better-layout", "brand", "copywriting", "cro", "design", "design-system", "docker-patterns", "find-skills", "frontend-design-anthropic", "gitlab-cli-skills", "gsap-performance", "gsap-scrolltrigger", "gsap-timeline", "humanizer", "improve-animations", "industrial-brutalist", "landing-page-design", "launch", "media-context", "minimalist-ui", "paseo-advisor", "paseo-committee", "paseo-handoff", "paseo-help", "premium-frontend-ui", "python-resilience", "review-animations", "rewind", "simplify", "skill-creator", "slides", "ui-styling", "ui-ux-pro-max", "web-design-engineer" ]
```

`read C:/Users/Administrator/.agents/.skills-disabled.json`:

```
{
  "version": 1,
  "disabled": [
    "biblicism-extractor"
  ],
  "note": "reference-checked; designer palette and paseo-* kept by design"
}
```

`biblicism-extractor` is NOT in the audit's unused list. The note's two exceptions explain 16 of the 37 (4 `paseo-*` + 12 designer-palette-adjacent: `banner-design`, `design`, `design-system`, `frontend-design-anthropic`, `industrial-brutalist`, `landing-page-design`, `minimalist-ui`, `premium-frontend-ui`, `slides`, `ui-styling`, `ui-ux-pro-max`, `web-design-engineer`), leaving exactly 21 (`animate-expo`, `animation-vocabulary`, `better-layout`, `brand`, `copywriting`, `cro`, `docker-patterns`, `find-skills`, `gitlab-cli-skills`, `gsap-performance`, `gsap-scrolltrigger`, `gsap-timeline`, `humanizer`, `improve-animations`, `launch`, `media-context`, `python-resilience`, `review-animations`, `rewind`, `simplify`, `skill-creator`) neither disabled nor covered. Of those 21 only `simplify` is referenced by the harness (`agent/agents/orchestrator.md:89`); the other 20 appear nowhere in `agent/`, `README.md` or `templates/` (grep). The row asks for "unused skills (90-day usage audit) moved to `~/.agents/skills-disabled/`"; one was moved. `C:/Users/Administrator/.agents/skills-disabled/` exists and holds exactly `biblicism-extractor`.
---

## 6. R05 — Docs — PROVEN

`README.md:119-122` (grep, verbatim):

```
119|- **Двойная приёмка (double acceptance):** если разрешённая модель Оракула относится к flash-классу (имя содержит `flash` либо это настроенный фоллбэк), одной проверки недостаточно — выполняются два независимых прохода приёмки...
120|- **Oracle-lite:** сокращённый единственный проход приёмки допускается только для малого среза (≤2 файла и ≤~80 строк диффа) и следует тому же протоколу доказательств, что полный Оракул...
121|- **Disabled skill (отключённый навык):** навык, перечисленный оператором в `~/.agents/.skills-disabled.json`; `tools/skills-doctor.mjs` сообщает о нём как `disabled by operator`...
122|- **Prune (очистка):** `tools/sync.ps1 -Prune` перечисляет файлы каркаса, отсутствующие в репозитории, в пределах каталогов, покрытых манифестом. Удаление выполняется только с `-Confirm`; по умолчанию это dry-run...
```

`CONTEXT.md:50-51` and `CONTEXT.md:115-116` (grep, verbatim):

```
50|- **Double acceptance** — the Wave 4 rule when the resolved oracle model is flash-class (name matches `*flash*` or is the configured fallback): two independent oracle passes, reconciled...
51|- **Oracle-lite** — a single-pass Wave 4 acceptance permitted only for a small slice (≤2 files, ≤~80 diff lines)...
115|- **Disabled skill** — a skill named in `~/.agents/.skills-disabled.json` (an operator's stop-list)...
116|- **Prune** — `tools/sync.ps1 -Prune`: lists harness files absent from the repo within manifest-covered directories (dry-run by default), deleting only with `-Confirm`...
```

VOCABULARY DRIFT GATE: `CONTEXT.md` exists and the new public entities of this diff are documented under the same names the code uses — `Disabled skill` (`.skills-disabled.json`), `Prune` (the doctor/sync-prune shared concept), and `--probe` "provider reachability" (`CONTEXT.md:132`: `Its optional `--probe` (network) checks provider reachability in `models.yml`...`). No synonym collision found; the check ids `orphan-files` / `MANIFEST_DIRS` are internal, not domain entities.

---

## 7. R06 — First real benchmark — PROVEN (I recomputed every number myself)

Raw inputs, read from `openspec/changes/hardening-2/benchmark/runs/*.json` (`durationMs` / `metrics.linesAdded`):

```
csv-sum-oneshot-1      32552ms  +64
csv-sum-oneshot-2      12958ms  +21
csv-sum-process-1      18567ms  +22
csv-sum-process-2      14854ms  +29
pagination-oneshot-1   10676ms  +1/-1
pagination-oneshot-2    9868ms  +1/-1
pagination-process-1   11288ms  +1/-1
pagination-process-2    8833ms  +1/-1
```

My recomputation vs the archived tool output (`report.txt`, `compare.txt`):

| cell | my arithmetic | archived | match |
|---|---|---|---|
| csv-sum oneshot | (32552+12958)/2 = 22755 | `22755ms` | yes |
| csv-sum process | (18567+14854)/2 = 16710.5 → 16711 | `16711ms` | yes |
| pagination oneshot | (10676+9868)/2 = 10272 | `10272ms` | yes |
| pagination process | (11288+8833)/2 = 10060.5 → 10061 | `10061ms` | yes |
| csv-sum LOC | (64+21)/2 = 42.5 → 43 ; (22+29)/2 = 25.5 → 26 | `+43/-0` → `+26/-0` ; `43 -> 26 (-39.5%)` | yes |
| aggregate LOC | (43+1) → (26+1) = 44 → 27 = -38.64% | `-38.6%` | yes |
| aggregate time | (22755+10272)=33027 → (16711+10061)=26772 = -18.94% | `-18.9%` | yes |

`report.txt` header is raw: `=== Отчет о бенчмарках (всего прогонов: 8) ===`, and the four row values `22755ms / 16711ms / 10272ms / 10061ms` with `Проверки 2/2` appear verbatim. `compare.txt` ends `Итог: -38.6% строк, -18.9% времени, checks 4/4 -> 4/4`.

Nuance (not a defect): with n=2 the tool prints the midpoint of the two samples and calls it `медиана`; the number is honest, the label is a simplification. The archive states the sample size honestly, `benchmark/README.md` verbatim: `**n=2 per cell on 2 toy tasks is not statistical evidence.**` — and the same file records the two harness defects this run found and fixed: `(1) metrics silently reported zero when `git add -A` failed ... and (2) tool-generated directories (`.opencode/**`, ~7 files / ~1045 lines per run) were counted as the agent's work` (the run JSONs corroborate: `metricsWarning`, `toolArtifacts.linesAdded 1044..1047`, `filesChanged 8`).

That the runs happened is checkable on disk, not just claimed: `glob D:/TMP/bench-real/bench/runs/*` → exactly the 8 run directories matching the 8 archived JSON names, and `glob D:/TMP/bench-real/bench/runs/2026-09-21T02-12-25-698Z-csv-sum-oneshot-1/*` → `result.json`, `agent.log`, `prompt.txt`, `repo/`.

---

## 8. R07 — No regressions — PROVEN

All with cwd `D:/ohmypi/workflow-repo`; exit codes printed by the shell:

```
> node --test "tools/tests/*.test.mjs"
ℹ tests 160
ℹ suites 2
ℹ pass 160
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
(duration_ms 21418.8988, exit 0)
```

```
> python --version && python tools/tests/test_session_cost.py
Python 3.12.9
EXIT_PY=0
........
Ran 8 tests in 0.013sOK
EXIT_A=0
```

```
> node tools/prompt-lint.mjs check --root .
prompt-lint: 80 prompt surfaces match the baseline.
EXIT_B=0
> node tools/prompt-lint.mjs scan --root .
prompt-lint: no volatile literals in 80 prompt surfaces.
EXIT_C=0
> node tools/prompt-lint.mjs sizes
prompt-lint: prompt size budget analysis  always       9.8 KB / max 16.0 KB      90 lines / max 200 lines  OK
  role-defs    50.7 KB / max 64.0 KB     890 lines / max 1200 lines OK
  rules        6.6 KB / max 16.0 KB      87 lines / max 250 lines  OK
  skills       22.2 KB / max 32.0 KB     136 lines / max 400 lines OK
EXIT_B=0
```

```
> powershell -NoProfile -File verify.ps1        -> exit 0, last line: "27/27 checks passed"
> powershell -NoProfile -File tools/audit.ps1   -> exit 0, last line: "all 14 checks clean"
> powershell -NoProfile -File tests/test-portability.ps1 -> exit 0, last line: "All 11 portability regression tests PASSED successfully!"
> node tools/doctor.mjs --probe                 -> exit 0: "Итог: pass=8 fail=0 warn=1 skip=1 -> OK"
> node tools/doctor.mjs                         -> exit 0: "Итог: pass=7 fail=0 warn=1 skip=1 -> OK"
> node tools/doctor.mjs --harness D:/ohmypi --json -> exit 0: "summary": { "pass": 8, "fail": 0, "warn": 1, "skip": 0 }, "ok": true
```

So "doctor 8/8" holds literally in installed mode and under `--probe` (`pass=8 fail=0`); repo mode yields 7 pass + 1 warn (`agent-wiring: Режим repo: агентская директория привязана к другому харнессу (D:/ohmypi)`) + 1 skip. Baselines were refreshed after the prompt edits: 80 surfaces match, and doctor reports `prompt-baseline : Бейзлайн промптов актуален (дрейф не обнаружен)`.

---

## 9. Secondary findings (not the reason for REJECT, but defects)

B-2. `tools/sync-prune.mjs` accepts a non-existent `--harness` and reports a clean empty result — the same silent-green class as B-1. REPRO: `node tools/sync-prune.mjs --harness Z:/nope --repo .` → `prune: 0 candidate(s)` / `EXIT_B=0`. Cause: `tools/sync-prune.mjs:150-153` validates presence only (`if (!args.harness || !args.repo) { ... "нужны --harness <dir> и --repo <dir>" ... return 2 }`), then `findPruneCandidates` swallows `readdirSync` errors (`catch { return; }`). The module header promises `2 — ошибка параметров`; a typo in the path is exactly that. FIX OWED: `existsSync(harness) && existsSync(repo)` guard + exit 2 (+ test).

B-3. `node tools/benchmark.mjs report` with no data exits 0 (`Запусков нет: сначала выполните benchmark run.`) and `compare` with no data exits 0 (`Нет общих данных для сравнения указанных армов.`). Informational commands, low severity, but a CI wrapper cannot distinguish "no data" from "all good".

B-4. `node tools/domain-context.mjs --domain "" --no-gh` → exit 0 with `Файлы: не найдено файлов, соответствующих домену ""` — empty value accepted where `--max-files abc` is rejected (exit 2). Trivial, but the empty string is never a meaningful domain.

Positive results of the same hunt (2-3 attacks per tool, raw exit codes):

| tool | attack | result as printed |
|---|---|---|
| debt-ledger | `scan --root Z:/definitely-missing` | `Каталог не найден: Z:/definitely-missing`, EXIT 2 |
| debt-ledger | `scan --bogus` | `Чисто: отложенных упрощений нет.`, **EXIT 0** (B-1) |
| benchmark | `run --runs 0 --yes` | `Ошибка: --runs требует целое число >= 1 (получено: 0).`, EXIT 2 |
| benchmark | `compare --baseline a` | `Ошибка: для compare необходимо указать --baseline <arm> и --candidate <arm>`, EXIT 1 |
| benchmark | `run --task nope ... --dry-run` | `Ошибка выполнения бенчмарка: Файл задач не найден: D:\ohmypi\workflow-repo\bench\tasks.json. Запустите init.`, EXIT 1 |
| usage-audit | `--day 30` | `Ошибка: неизвестный параметр --day.` + usage, EXIT 2 |
| usage-audit | `--days abc` | `Ошибка: --days требует целое число >= 1 (получено: "abc").`, EXIT 2 |
| usage-audit | `--sessions Z:/no-sessions --json` | JSON `"reason": "Сессий не найдено"`, EXIT 0 |
| domain-context | `--domain` (no value) | `Ошибка: параметр --domain обязателен.`, EXIT 2 |
| domain-context | `--max-files abc` | `Ошибка: --max-files требует целое число >= 1 (получено: "abc").`, EXIT 2 |
| domain-context | `--bogus` | `Ошибка: неизвестный или неполный параметр --bogus.`, EXIT 2 |
| context-inbox | `resolve` (no --id) | `Ошибка: Параметр --id обязателен.`, EXIT 1 |
| context-inbox | `frobnicate` | usage dump, EXIT 1 |
| context-inbox | `check --root Z:/nope` | `Ошибки проверки REQUESTS.md: - Файл REQUESTS.md не найден...`, EXIT 1 |
| oracle-model | `bogus` | `Неизвестная команда: bogus`, EXIT 1 |
| oracle-model | `list --bogus` | resolves model, EXIT 0 (read-only list; benign) |
| prompt-lint | `sizes --root Z:/nope` | `prompt-lint: --root 'Z:/nope' is not an existing directory.`, EXIT 2 |
| prompt-lint | `bogus` | `prompt-lint: unknown command 'bogus'.`, EXIT 1 |
| doctor | `--harness Z:/nope` | 4x FAIL with per-file detail, `Итог: pass=2 fail=4 warn=2 skip=1 -> FAIL`, EXIT 1 |

---

## 10. Process finding — the whole change is UNCOMMITTED (rule 11)

`git status --short --untracked-files=all` (cwd `D:/ohmypi/workflow-repo`), raw head and tail:

```
 M .gitignore / M CONTEXT.md / M README.md / M agent/AGENTS.md / M agent/agents/oracle.md / M agent/agents/orchestrator.md / M agent/mcp.json.example / M install.ps1 / M tests/test-portability.ps1 / M tests/test-sync-guard.ps1 / M tools/benchmark.mjs / M tools/context-inbox.mjs / M tools/debt-ledger.mjs / M tools/doctor.mjs / M tools/domain-context.mjs / M tools/oracle-model.mjs / M tools/prompt-lint.mjs / M tools/skills-doctor.mjs / M tools/sync.ps1 / M tools/tests/*.test.mjs (10 files) / M tools/usage-audit.mjs / M tools/workflow.mjs
?? openspec/changes/hardening-2/benchmark/README.md, compare.txt, report.txt, runs/*.json (8)
?? openspec/changes/hardening-2/interfaces.md, manifest.md, proposal.md, specs/hardening-2/spec.md, tasks.md
?? tools/sync-prune.mjs
?? tools/test-lens.mjs
?? tools/tests/skills-doctor.test.mjs
?? tools/tests/sync-prune.test.mjs
```

`git diff HEAD --stat` → `30 files changed, 2411 insertions(+), 185 deletions(-)`. HEAD is `5b6f9832017a85c44fab3d1e8659a267b31474ee`, whose own stat touches only three `openspec/changes/*/tasks.md` files. Consequence: the fixed defects' causes exist only as source comments (§3) — there is no commit/PR stating the hypothesis, and the entire R06 evidence archive plus the manifest is untracked, i.e. one `git clean -fd` from oblivion. This is a rule-11 deviation, not a row failure, and it is reported rather than silently judged.

---

## 11. NOT PROVEN

- NOT PROVEN: replay-cassette coverage for the diff's NEW network path — `tools/doctor.mjs:779-790` adds `provider-reachability`, and the working-tree usage line names it (`node tools/doctor.mjs [--harness <dir>] [--agent-dir <dir>] [--agents-home <dir>] [--json] [--quiet] [--probe]`) while the HEAD copy does not (`git show HEAD:tools/doctor.mjs` → 20740 bytes, usage line without `--probe`; grep for `provider-reachability|probeResults|fetch(` in that HEAD copy → no matches). Its tests are the classic same-process mock: `tools/tests/doctor.test.mjs:97` `const server = createServer(handler)` used by `doctor.test.mjs:603` `probeProviders: живой /models → reachable, мёртвый порт → unreachable, без baseUrl → null`. No cassette exists for that path — the only cassette in the tree, `.probe/c.json`, records `GET /markets?api_key=[REDACTED]` against `http://127.0.0.1:9111`, unrelated. Per rule 10 the letter is unmet; what I did observe live is the happy path: `node tools/doctor.mjs --probe` → `✓ [PASS] provider-reachability : Провайдеры отвечают (nullform-gateway, omniroute).`
- NOT PROVEN: "each finding recorded as repro → cause → fix" as a standalone finding log. The only candidate artifact is `tasks.md`, which my blindness protocol forbids me to open, so I neither read it nor judged it. What I could verify without it: the cause statements in source (§3), the regression tests (§3), and the two benchmark-harness defects recorded in `benchmark/README.md` (§7).
- NOT PROVEN: re-execution of the 8 `omp -p` benchmark runs — they need the throwaway repo and a live flash model; I corroborated them by on-disk artifacts (`D:/TMP/bench-real/bench/runs/` with 8 dirs, each holding `result.json`, `agent.log`, `prompt.txt`, `repo/`) and by recomputing every published number (all matched).
- NOT PROVEN (out of scope of my tooling): `openspec validate` for the change — I did not run it, to avoid touching the scaffolding my protocol keeps me blind from.

---

## 12. Round-1 verdict and its reasons (as originally filed)

1. R02 is not met. The bug hunt fixed one defect class in three of its seven named tools and left it in a fourth: `node tools/debt-ledger.mjs scan --check --markr TODO` exits **0** on a tree where the correct spelling exits **1**. Cause: `tools/debt-ledger.mjs:457` `args.root = argv[++i]` / `:469-470` — unknown flags are swallowed (} else if (!arg.startsWith("-")) { args._.push(arg); }), so `--markr TODO` never reaches the marker check — no validation, in a file that already validates `--write`. Fix owed with a regression test (B-1).
2. R04 is partially met: 37 skills are unused per the 90-day audit, exactly 21 of them outside the `.skills-disabled.json` note's two exceptions, and 1 was moved — which is not one of the 21 (indeed not one of the 37). The live registry was not trimmed as the row requires.
3. Rule 11 deviation: no commit exists for the diff (`30 files changed, 2411 insertions(+), 185 deletions(-)` all uncommitted, HEAD `5b6f983`), so the corrected hypotheses live only in code comments and the R06 archive is untracked.
4. Rule 10: the new `--probe` network path has no replay cassette; only a same-process mock plus my live happy-path run.

Everything else (R01, R03, R05, R06, R07 and the four big suites) is green with raw evidence above. The product runs, the numbers are reproducible, and the acceptance protocol itself is now enforced in the role — but a gate that silently passes on a typo is exactly the failure this change set out to remove, and it survived in the tool the other gates lean on.
---

## Re-verification (round 2) — narrow re-review of B-1, B-2 and R04

All commands re-run with an explicit cwd `D:/ohmypi/workflow-repo`, exit codes printed by the shell.

### B-1 FIXED — `debt-ledger` now rejects a mistyped flag and a value-less flag

```
> node tools/debt-ledger.mjs scan --check --markr TODO & echo EXIT_A=!errorlevel!
Ошибка: неизвестный флаг --markr.
debt-ledger.mjs — инвентаризация и контроль отложенных упрощений (defer-маркеров)...
  --marker <key>         Ключевое слово маркера (по умолчанию: "defer")
EXIT_A=2
> node tools/debt-ledger.mjs scan --check --marker TODO & echo EXIT_B=!errorlevel!
## skills/skill-creator/scripts/init_skill.py
  skills/skill-creator/scripts/init_skill.py:119 — Add actual script logic here | [no-trigger]1 маркеров, 1 без триггера.
EXIT_B=1
> node tools/debt-ledger.mjs scan --root & echo EXIT_C=!errorlevel!
Ошибка: флаг --root требует значение.
...
EXIT_C=2
> node tools/debt-ledger.mjs scan --root Z:/definitely-missing & echo EXIT_D=!errorlevel!
Каталог не найден: Z:/definitely-missing
EXIT_D=2
```

Control that matters: the gate is still RED on the real finding (`EXIT_B=1`) — the stricter parser did not neuter the tool, it only closed the false-green. The same class fix propagated to the two siblings the round-1 report named, verified live:

```
> node tools/context-inbox.mjs list --bogus & echo EXIT_D=!errorlevel!
Ошибка: неизвестный флаг --bogus.
...
EXIT_D=2
> node tools/prompt-lint.mjs sizes --chek & echo EXIT_E=!errorlevel!
prompt-lint: неизвестный флаг --chek.
...
EXIT_E=2
```

Regression tests added, each one able to be red before the fix (grep, verbatim):

```
debt-ledger.test.mjs:417|    // `--markr TODO` до фикса молча игнорировался и давал «Чисто» + exit 0
debt-ledger.test.mjs:421|    assert.equal(typo.status, 2);
debt-ledger.test.mjs:422|    assert.match(typo.stderr, /неизвестный флаг --markr/);
debt-ledger.test.mjs:423|    assert.doesNotMatch(typo.stdout, /Чисто/);
debt-ledger.test.mjs:441|      ["scan", "--root"],
context-inbox.test.mjs:257|    assert.equal(bogus.status, 2);
context-inbox.test.mjs:258|    assert.match(bogus.stderr, /неизвестный флаг --bogus/);
context-inbox.test.mjs:262|    assert.match(missing.stderr, /--id требует значение/);
context-inbox.test.mjs:266|    assert.match(flagAsValue.stderr, /--file требует значение/);
prompt-cache.test.mjs:322|    assert.equal(typo.status, 2);
prompt-cache.test.mjs:323|    assert.match(typo.stderr, /неизвестный флаг --chek/);
prompt-cache.test.mjs:327|    assert.match(missing.stderr, /--root требует значение/);
```

### B-2 FIXED — `sync-prune` rejects a bad path and `sync.ps1 -Prune` propagates it

```
> node tools/sync-prune.mjs --harness Z:/nope --repo . & echo EXIT_E=!errorlevel!
sync-prune: --harness не найден: Z:\nope
EXIT_E=2
> node tools/sync-prune.mjs --harness . --repo . & echo EXIT_F=!errorlevel!
prune: 0 candidate(s)
EXIT_F=0
> powershell -NoProfile -ExecutionPolicy Bypass -File tools/sync.ps1 -Prune -HarnessRoot D:/nope-dir & echo EXIT_A=!errorlevel!
sync-prune: --harness не найден: D:\nope-dir
sync: prune failed (exit 2)
EXIT_A=2
```

Cause stated in code: `tools/sync-prune.mjs:82` `function pathProblem(dir, label) {` / `:83` `if (!existsSync(dir)) return `${label} не найден: ${dir}`;` / `:85` `if (!statSync(dir).isDirectory()) return `${label} не каталог: ${dir}`;`, wired at `:181-182` `process.stderr.write(`sync-prune: ${err.message}\n`); return 2;`. Tests, including the must-not-false-green assertions: `sync-prune.test.mjs:144-150`, `:156-178`, `:169|    assert.ok(!badHarness.stdout.includes("candidate"), "typo must not be reported as clean");`, `:178|    assert.ok(existsSync(join(harness, "tools/extra.mjs")), "--delete must not run on a bad repo path");`.

Residual (unchanged, non-blocking, and NOT part of the prune logic): a non-existent DRIVE still trips the wrapper's own root resolution — `powershell ... tools/sync.ps1 -Prune -HarnessRoot Z:/nope` → `Join-Path : Cannot find drive. A drive with the name 'Z' does not exist.` / `At D:\ohmypi\workflow-repo\tools\sync.ps1:49 char:6` / `EXIT_B=1`. It fails loudly (never green), just with a raw PowerShell error instead of the clean RU message and code 2.

### R04 upgraded to PROVEN — the registry note now accounts for all 37, and every bucket checks out on disk

`read C:/Users/Administrator/.agents/.skills-disabled.json` (verbatim):

```
{
  "version": 1,
  "disabled": [
    "biblicism-extractor"
  ],
  "note": "reference-checked; kept by design: lock-managed (15, .skill-lock.json), designer palette (17 referenced by agent/agents/designer.md), paseo-* (4, phrase-triggered), media-context (1, feature); only biblicism-extractor disabled"
}
```

I re-derived the partition myself instead of trusting the note (`node -e` reading `~/.agents/.skill-lock.json`, `~/.agents/skills/<name>/SKILL.md`, `agent/agents/designer.md` and the 37 names from `usage-audit --days 90 --json`):

```
UNUSED=37
LOCK_MANAGED=15 -> banner-design,brand,design,design-system,docker-patterns,find-skills,gitlab-cli-skills,humanizer,python-resilience,rewind,simplify,skill-creator,slides,ui-styling,ui-ux-pro-max
DESIGNER_REF=21 -> animate-expo,animation-vocabulary,better-layout,brand,copywriting,cro,design,design-system,gsap-performance,gsap-scrolltrigger,gsap-timeline,humanizer,improve-animations,industrial-brutalist,landing-page-design,launch,minimalist-ui,premium-frontend-ui,review-animations,ui-ux-pro-max,web-design-engineer
PASEO=4 -> paseo-advisor,paseo-committee,paseo-handoff,paseo-help
MEDIA=1 -> media-context
SUM=41
UNCOVERED=1 -> frontend-design-anthropic
```

`LOCK_MANAGED=15`, `PASEO=4`, `MEDIA=1` confirm the note's three smaller buckets exactly. `DESIGNER_REF=21` overlaps the lock bucket (brand, design, design-system, humanizer, ui-ux-pro-max are both), which is why my first pass reported `SUM=41 / UNCOVERED=1`: the only uncovered name was `frontend-design-anthropic`, and that was MY matching artefact — the directory's DECLARED name is `frontend-design` (`skills-doctor: frontend-design-anthropic: declares name 'frontend-design' (directory is 'frontend-design-anthropic')`), and `agent/agents/designer.md:11` says `1. RESEARCH & DIRECTION: \`refero-design\` + \`frontend-design\` (aesthetic direction, subject grounding, anti-template thesis) ...`. So the residual set after the three smaller buckets is exactly 17, all 17 reachable from `designer.md`, and 15+17+4+1 = 37. Spot-check of the buckets themselves, `agent/agents/designer.md:11-14`: `2. ENGINEERING CRAFT: \`better-ui\`, \`better-interface\`, \`better-layout\`, \`better-typography\`, \`better-colors\`, \`better-accessibility\`` · `3. SYSTEM & COMPONENTS: \`ui-ux-pro-max\`, \`design-system\`, \`premium-frontend-ui\`` · `4. MOTION: \`animate\`, \`animate-expo\`, \`animation-vocabulary\`, \`improve-animations\`, \`review-animations\` + GSAP set (\`gsap-core\`, \`gsap-scrolltrigger\`, \`gsap-timeline\`, \`gsap-performance\`)`.

Consequence for the row: moving those 37 would not trim dead weight, it would break live `skill://` references (designer pipeline, paseo phrasing, media feature) or fight the installer's own lock logic (`install.ps1:224-226` skips lock-managed skills by path). The operator acted only where action was safe (1 moved: `biblicism-extractor`, which the 90-day audit did not flag) and recorded a per-skill reason in the registry record — which is what the row's "unused skills moved" was protecting against. R04 → PROVEN.

### Suites after the fixes

```
> node --test "tools/tests/*.test.mjs"
ℹ tests 166
ℹ suites 2
ℹ pass 166
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
(duration_ms 20818.0712, exit 0)
```

160 → 166: six new regression tests, all green; total for the round-1 suites (verify 27/27, audit 14 clean, portability 11 passed, python 8 OK, doctor pass=8 fail=0) was re-checked only where the fixes touch it, per the narrow scope of this round.

### Residual disclosures (unchanged by round 2; none of them a manifest-row failure)

- rule 10: still no replay cassette for doctor's `--probe` network path; the live happy path was observed (`Провайдеры отвечают (nullform-gateway, omniroute)`), the dead-provider / no-baseUrl branches remain mock-only.
- rule 11: `git diff HEAD --stat` is still `30 files changed, 2411 insertions(+), 185 deletions(-)` of uncommitted work; the hypotheses are now recorded in test comments as well as source comments (`debt-ledger.test.mjs:417`).
- B-3 (unchanged, low): `node tools/benchmark.mjs report` → `Запусков нет: сначала выполните benchmark run.` EXIT_A=0; `compare --baseline oneshot --candidate process` → `Нет общих данных для сравнения указанных армов.` EXIT_B=0.
- B-4 (unchanged, trivial): `node tools/domain-context.mjs --domain "" --no-gh` → `Файлы: не найдено файлов, соответствующих домену ""` EXIT_C=0.

### Round-2 verdict

R02 → **PROVEN**. R04 → **PROVEN**. B-1 → **fixed**. B-2 → **fixed**. No regression in the fixed surfaces (debt gate still red on the real finding; prune still clean on a valid harness; 166/166). **Overall: ACCEPT**, carrying the four residual disclosures above as known, non-blocking.