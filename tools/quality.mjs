#!/usr/bin/env node
/**
 * tools/quality.mjs — stack-aware static-analysis gate with a cognitive-complexity ratchet.
 *
 * Answers one question per command:
 *   detect    which stacks are in this project, and what proved it
 *   plan      what install would do (argv per stack), touching nothing
 *   install   write the harness-owned sidecar configs and seed the baseline
 *   check     fail on COCO above threshold for anything not baselined, or on growth
 *   baseline  re-seed the baseline (may only lower a value, never raise it)
 *
 * CLI:
 *   node tools/quality.mjs detect  [--root <dir>] [--json]
 *   node tools/quality.mjs plan    [--root <dir>] [--stack <id>] [--json]
 *   node tools/quality.mjs install [--root <dir>] [--stack <id>] [--dry-run] [--json]
 *   node tools/quality.mjs check   [--root <dir>] [--stack <id>] [--changed] [--json]
 *   node tools/quality.mjs baseline [--root <dir>] [--stack <id>] [--dry-run] [--prune] [--json]
 */

import { existsSync, realpathSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE_FILE,
  SIDECAR_DIR,
  loadStacks,
  detectStacks,
  expandArgv,
  runStack,
  loadBaseline,
  saveBaseline,
  applyRatchet,
  mergeBaselineEntries,
  changedFiles,
  nameRows,
  disambiguate,
  writeConfigs,
  seedBaseline,
  installAnalyzer,
} from "./quality/engine.mjs";

export * from "./quality/engine.mjs";

/* ------------------------------------------------------------------------- CLI */

export function parseArgs(argv) {
  const args = { _: [], root: ".", stack: null, json: false, dryRun: false, changed: false, help: false, baseline: null, allowHostInstall: false, prune: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--allow-host-install") args.allowHostInstall = true;
    else if (arg === "--changed") args.changed = true;
    else if (arg === "--prune") args.prune = true;
    else if (arg === "--root") args.root = argv[++i] || ".";
    else if (arg === "--stack") args.stack = argv[++i] || "";
    else if (arg === "--baseline") args.baseline = argv[++i] || "";
    else if (arg.startsWith("-")) args.errors.push(`unknown flag ${arg}`);
    else args._.push(arg);
  }
  if (args.errors.length === 0 && args._.length === 0) args.errors.push("missing command (detect|plan|install|check|baseline)");
  return args;
}

function selectStacks(doc, detected, only) {
  if (!only) return detected;
  const wanted = detected.find((s) => s.id === only);
  if (!wanted) throw new Error(`stack '${only}' not detected in this project (detected: ${detected.map((s) => s.id).join(", ") || "none"})`);
  return [wanted];
}

function resolveSelection(doc, detected, only, err) {
  try { return { chosen: selectStacks(doc, detected, only) }; }
  catch (e) { err.write(`quality: ${e.message}\n`); return { error: true }; }
}

function cmdDetect(ctx) {
  const { detected, emit, root } = ctx;
  const rows = detected.map((s) => `  ${s.id.padEnd(8)} ${s.coco.padEnd(6)} proof=${s.proof.padEnd(24)} ${s.verifiedOn ? "verified: " + s.verifiedOn : "UNPROVEN on this host"}`);
  emit({ ok: true, root, stacks: detected }, detected.length ? `Detected stacks:\n${rows.join("\n")}\n` : "No known stack markers found.\n");
  return 0;
}

function cmdPlan(ctx) {
  const { doc, detected, args, root, qualityDir, emit, err } = ctx;
  const { chosen, error } = resolveSelection(doc, detected, args.stack, err);
  if (error) return 2;
  const plan = chosen.map((s) => {
    const stack = doc.stacks.find((x) => x.id === s.id);
    return {
      id: s.id, coco: s.coco, metric: s.metric, threshold: stack.threshold,
      install: stack.install ? expandArgv(stack.install.argv, { root, qualityDir, stack }) : null,
      run: stack.run ? expandArgv(stack.run.argv, { root, qualityDir, stack, files: [] }) : null,
      configs: Object.keys(stack.configs || {}).map((rel) => `${qualityDir}/${rel}`),
    };
  });
  emit({ ok: true, root, plan }, plan.map((p) => `${p.id}: ${p.metric}\n  threshold ${p.threshold} (${p.coco})\n  install ${p.install ? p.install.join(" ") : "ships with toolchain"}\n  configs ${p.configs.join(", ") || "none"}\n`).join(""));
  return 0;
}

function cmdInstall(ctx) {
  const { doc, detected, args, root, qualityDir, emit, err, baselineFile } = ctx;
  const { chosen, error } = resolveSelection(doc, detected, args.stack, err);
  if (error) return 2;
  const actions = chosen.map((s) => {
    const stack = doc.stacks.find((x) => x.id === s.id);
    if (args.dryRun) {
      const variant = stack.install?.whenPresent && existsSync(join(root, stack.install.whenPresent.marker)) ? stack.install.whenPresent : stack.install;
      return { id: s.id, configs: Object.keys(stack.configs || {}), install: variant ? expandArgv(variant.argv, { root, qualityDir, stack }) : null, status: "dry-run" };
    }
    const configs = writeConfigs(root, stack, doc);
    return { id: s.id, configs, install: installAnalyzer(stack, { root, qualityDir, allowHostInstall: args.allowHostInstall }) };
  });
  if (!args.dryRun) seedBaseline(root, doc, chosen, qualityDir, baselineFile, err);
  const text = actions.map((a) => `${a.id}: ${a.status || a.install?.status || "installed"} ${JSON.stringify(a.configs)}${a.install?.detail ? ` — ${a.install.detail}` : ""}\n`).join("")
    + (args.dryRun ? "" : `baseline seeded in ${baselineFile}\n`);
  emit({ ok: true, root, actions }, text);
  return 0;
}

function cmdBaseline(ctx) {
  const { doc, detected, args, root, qualityDir, emit, err, baselineFile } = ctx;
  const { chosen, error } = resolveSelection(doc, detected, args.stack, err);
  if (error) return 2;
  const baseline = loadBaseline(root, baselineFile);
  const report = chosen.map((s) => {
    const stack = doc.stacks.find((x) => x.id === s.id);
    const result = runStack(stack, { root, qualityDir, files: null });
    if (result.status !== "ran") return { id: s.id, status: result.status };
    const previous = baseline.stacks[s.id]?.functions || {};
    const rows = disambiguate(nameRows(root, s.id, result.rows)).filter((r) => r.coco > stack.threshold);
    const merged = mergeBaselineEntries(previous, rows, { prune: args.prune });
    baseline.stacks[s.id] = { threshold: stack.threshold, seeded: true, functions: merged.functions };
    return { id: s.id, offenders: Object.keys(merged.functions).length, lowered: merged.lowered, orphans: merged.orphans, pruned: merged.pruned };
  });
  if (!args.dryRun) saveBaseline(root, baseline, baselineFile);
  emit({ ok: true, root, report, dryRun: args.dryRun }, report.map((r) => `${r.id}: ${r.offenders ?? "-"} baselined, ${r.lowered ?? 0} lowered${r.orphans ? `, ${r.orphans} kept without a current match (rename? use --prune to drop)` : ""}${r.pruned ? `, ${r.pruned} pruned` : ""}${r.status ? ` (${r.status})` : ""}\n`).join("") + (args.dryRun ? "dry-run: nothing written\n" : `updated ${baselineFile}\n`));
  return 0;
}

function checkOneStack(s, ctx, baseline, unverifiedRef) {
  const { doc, args, root, qualityDir } = ctx;
  const stack = doc.stacks.find((x) => x.id === s.id);
  const files = args.changed ? changedFiles(root, stack) : null;
  if (args.changed && files !== null && files.length === 0) return { id: s.id, status: "no-changes", failures: [] };
  const result = runStack(stack, { root, qualityDir, files });
  if (result.status !== "ran") {
    unverifiedRef.value = true;
    return { id: s.id, status: result.status, detail: result.detail || null, failures: [] };
  }
  if (baseline.stacks[s.id]?.seeded !== true) {
    unverifiedRef.value = true;
    return { id: s.id, status: "unseeded", detail: `baseline not seeded — run: node tools/quality.mjs baseline --stack ${s.id}`, failures: [] };
  }
  const rows = disambiguate(nameRows(root, s.id, result.rows));
  const { failures } = applyRatchet(rows, baseline.stacks[s.id]?.functions || {}, stack.threshold);
  return { id: s.id, status: failures.length ? "fail" : "pass", coco: s.coco, checked: rows.length, failures };
}

function formatCheck(results, ok) {
  const body = results.map((r) => {
    const head = `  ${r.id.padEnd(8)} ${r.status}${r.checked !== undefined ? ` (${r.checked} functions)` : ""}${r.detail ? ` — ${r.detail}` : ""}`;
    return [head, ...r.failures.map((f) => `      ${f.message}`)].join("\n");
  }).join("\n");
  const failures = results.reduce((n, r) => n + r.failures.length, 0);
  const tail = ok ? "COCO ratchet clean." : failures ? `FAIL: ${failures} violation(s).` : "UNVERIFIED: analyzer did not run.";
  return `${body}\n${tail}\n`;
}

function cmdCheck(ctx) {
  const { doc, detected, args, root, emit, err, baselineFile } = ctx;
  const { chosen, error } = resolveSelection(doc, detected, args.stack, err);
  if (error) return 2;
  if (chosen.length === 0) { err.write("quality: no known stack detected; nothing to check (not a pass)\n"); return 2; }
  const baseline = loadBaseline(root, baselineFile);
  const unverifiedRef = { value: false };
  const results = chosen.map((s) => checkOneStack(s, ctx, baseline, unverifiedRef));
  const ok = results.every((r) => r.status !== "fail") && !unverifiedRef.value;
  emit({ ok, root, results }, formatCheck(results, ok));
  return ok ? 0 : 1;
}

export function runQualityCli(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const args = parseArgs(argv);
  if (args.help) { out.write(HELP); return 0; }
  if (args.errors.length) { for (const e of args.errors) err.write(`quality: ${e}\n`); return 2; }

  const command = args._[0];
  const root = resolve(args.root);
  if (!existsSync(root)) { err.write(`quality: root not found: ${root}\n`); return 2; }

  let doc;
  try { doc = loadStacks(); } catch (e) { err.write(`quality: ${e.message}\n`); return 2; }

  const emit = (payload, text) => { if (args.json) out.write(JSON.stringify(payload, null, 2) + "\n"); else out.write(text); };
  const ctx = {
    doc, args, root, err, emit, command,
    detected: detectStacks(root, doc),
    baselineFile: args.baseline || doc.defaults?.baselineFile || BASELINE_FILE,
    qualityDir: relative(root, join(root, doc.defaults?.sidecarDir || SIDECAR_DIR)).split(sep).join("/"),
  };
  const commands = { detect: cmdDetect, plan: cmdPlan, install: cmdInstall, baseline: cmdBaseline, check: cmdCheck };
  const handler = commands[command];
  if (!handler) { err.write(`quality: unknown command '${command}'\n${HELP}`); return 2; }
  return handler(ctx);
}

const HELP = `quality.mjs — stack-aware static analysis with a cognitive-complexity ratchet

  node tools/quality.mjs detect   [--root <dir>] [--json]
  node tools/quality.mjs plan     [--root <dir>] [--stack <id>] [--json]
  node tools/quality.mjs install  [--root <dir>] [--stack <id>] [--dry-run] [--allow-host-install] [--json]
  node tools/quality.mjs check    [--root <dir>] [--stack <id>] [--changed] [--json]
  node tools/quality.mjs baseline [--root <dir>] [--stack <id>] [--dry-run] [--json]

Installs are refused outside a project virtualenv unless --allow-host-install is
given; that flag is for disposable CI runners, not a developer machine.
Exit: 0 clean · 1 violation or unverified · 2 cannot run.
A missing analyzer reports "unverified", never "pass". See docs/quality-gate.md.
`;

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  process.exitCode = runQualityCli();
}
