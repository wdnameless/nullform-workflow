#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runBenchmark, loadTasks, summarizeRuns, compareArms } from "./benchmark.mjs";
import { DEFAULT_MODEL, CAPS, FIXED_TARIFFS, REQUEST_RESERVE_USD, LEDGER_FILE, loadSpendLedger, assertBudgetReady } from "./bench-budget.mjs";
import { readRunOutcome } from "./bench-results.mjs";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { root: ".", model: DEFAULT_MODEL, ceiling: 1, dryRun: false, yes: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (["--dry-run", "--yes", "--json"].includes(flag)) args[{ "--dry-run": "dryRun", "--yes": "yes", "--json": "json" }[flag]] = true;
    else if (["--root", "--model", "--ceiling", "--task"].includes(flag) && argv[i + 1]) args[flag.slice(2)] = flag === "--ceiling" ? Number(argv[++i]) : argv[++i];
    else throw new Error(`Unknown/missing option ${flag}`);
  }
  return args;
}

export function runSkillBenefitEval(options = {}) {
  const root = resolve(options.root || "."), model = options.model || DEFAULT_MODEL;
  const ceiling = options.ceiling ?? 1;
  if (!FIXED_TARIFFS[model] || typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 1) throw new Error("Exact fixed model and numeric ceiling in (0,1] required");
  const ledger = loadSpendLedger(root);
  assertBudgetReady(ledger);
  const tasks = loadTasks(root).tasks.filter(t => options.task ? t.id === options.task : t.id.startsWith("eval-"));
  if (!tasks.length || tasks.some(t => !["requesting-code-review", "nullform-workflow-full"].includes(t.candidateSkill))) throw new Error("No valid selected evaluation tasks");
  for (const task of tasks) if (!readFileSync(join(root, "skills", task.candidateSkill, "SKILL.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()) throw new Error("Empty candidate skill body");
  const runner = join(root, "tools", "bench-session-runner.ts");
  const setup = spawnSync("bun", [runner, "--setup-only", "--root", root, "--model", model], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120000 });
  if (setup.error || setup.status !== 0) throw new Error(`Native SDK setup failed without API: ${setup.error?.message || setup.stderr}`);
  let nativeSetup;
  try { nativeSetup = JSON.parse(setup.stdout.trim()); } catch { throw new Error("Malformed native setup report"); }
  if (nativeSetup.setup !== "ready" || nativeSetup.selector !== model) throw new Error("Native setup attribution mismatch");
  const maximumRequests = tasks.reduce((n,t) => n + 2 * (t.id.includes("workflow") ? CAPS.workflowRequests : 1), 0);
  const plan = { model, ceiling: Math.min(ceiling, ledger.ceiling_usd), nativeSetup, sessions: tasks.length * 2, maximumRequests, maxProjectedSpend: maximumRequests * REQUEST_RESERVE_USD, currentLedgerSpend: ledger.cumulative_tariff_usd, tasks: tasks.map(t => ({ id: t.id, candidateSkill: t.candidateSkill })), caps: CAPS, tariffSource: "installed SDK fixed catalog; not independently confirmed provider billing" };
  if (options.dryRun) return { status: "dry-run", plan };
  if (!options.yes) throw new Error("Use --dry-run for setup, --yes for approved fresh calls");
  mkdirSync(join(root, "bench", "runs"), { recursive: true });
  const lockPath = join(root, "bench", "runs", "skill-benefit-eval.lock");
  const lock = openSync(lockPath, "wx");
  const cohortId = randomUUID(), runs = [], reportPath = join(root, "bench", "runs", `comparison-${cohortId}.json`);
  const outcome = { status: "running", cohortId, plan, runs, ledger: LEDGER_FILE, dataset: "constructed representative code/consumer patterns, not production dataset", activationMeasure: "instruction adherence/nonactivation under explicit target-body injection; not automatic discovery/JEV selection", billing: plan.tariffSource };
  const persist = () => writeFileSync(reportPath, JSON.stringify(outcome, null, 2) + "\n");
  persist();
  try {
    for (const task of tasks) for (const arm of ["baseline-noskill", "candidate-skill"]) {
      assertBudgetReady(loadSpendLedger(root));
      const cmd = `bun "${runner}" --root "${root}" --task {task_id} --arm {arm} --prompt-file "{prompt_file}" --run-dir "{run_dir}" --model ${model} --ceiling ${ceiling}${arm === "candidate-skill" ? ` --skill ${task.candidateSkill}` : ""}`;
      const result = runBenchmark({ root, taskId: task.id, arm, cmd, runs: 1, timeoutSec: task.timeoutSec || 120, transcript: "{run_dir}/session/session.jsonl", yes: true })[0];
      const observed = { task: task.id, arm, runId: result.runId, runDir: result.runDir, durationMs: result.durationMs, status: result.status, checks: result.checks };
      runs.push(observed); persist();
      Object.assign(observed, readRunOutcome(result, model, loadSpendLedger(root)));
      const resultPath = join(result.runDir, "result.json");
      result.cost = { total_usd: observed.tariff_usd, sdk_tariff_usd: observed.tariff_usd, source: plan.tariffSource };
      for (const check of result.checks) check.passed = check.passed && observed.score?.requirementsSatisfied === true;
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
      if (arm === "candidate-skill") {
        const baseline = runs.find(r => r.task === task.id && r.arm === "baseline-noskill");
        if (baseline.input.fixtureHash !== observed.input.fixtureHash || baseline.input.selector !== observed.input.selector || baseline.input.skillHash !== null || !observed.input.skillHash || baseline.sessionId === observed.sessionId) throw new Error("Unequal paired inputs or reused native session");
      }
      persist();
    }
    outcome.status = runs.some(run => run.evaluationStatus === "failed") ? "completed-with-failures" : "completed";
    outcome.comparison = compareArms(summarizeRuns(root, { runIds: runs.map(r => r.runId) }), "baseline-noskill", "candidate-skill");
    outcome.cumulativeSpend = loadSpendLedger(root).cumulative_tariff_usd;
    persist();
    return { ...outcome, reportPath };
  } catch (error) {
    outcome.status = "halted"; outcome.error = error.message; outcome.cumulativeSpend = loadSpendLedger(root).cumulative_tariff_usd; persist();
    throw new Error(`${error.message}; evidence: ${reportPath}`);
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = runSkillBenefitEval(parseArgs()); console.log(JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
