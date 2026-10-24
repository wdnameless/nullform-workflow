/**
 * tools/harness-setup.mjs — `nullform setup`: детект харнесса с причинами,
 * план, подтверждение, установка. И `nullform heal`: диагностика → минимальный
 * ремонт → повторная проверка.
 *
 * Почему отдельным модулем: bin/nullform.mjs уже за порогом code-size, а тут две
 * самостоятельные команды с собственными контрактами (R05/R06/R07).
 */
import { join, resolve, relative } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { sanitizeError, readInstallationState, writeInstallationState, readLocalVersion } from "./self-update.mjs";
import { installHarness, discoverCandidatesDetailed, SUPPORTED_HARNESSES } from "./install-harness.mjs";
import { resolveHostHome } from "./installation/profiles.mjs";
import { runDoctor } from "./doctor.mjs";


/** Корень установленного пакета: источник файлов для восстановления. */
const PACKAGE_ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")), "..");

const DEFAULT_ROOT_HOME = (harness, userHome) => join(userHome, `.nullform`, harness);

/**
 * Единый DI-контекст команд: env/streams/emit. Раньше эти пять строк дублировались
 * в каждой команде (и в bin/nullform.mjs), поэтому вынесены в одно место.
 */
function commandContext(deps = {}) {
  const env = deps.env || process.env;
  const output = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const emit = (json, payload, text, toStderr = false) => {
    if (json) output.write(JSON.stringify(payload, null, 2) + "\n");
    else (toStderr ? errOut : output).write(text);
  };
  const userHome = resolve(
    deps.userHome || env.NULLFORM_USER_HOME || join(env.HOME || env.USERPROFILE || ".", ""),
  );
  return { env, output, errOut, emit, userHome };
}

/** Human-readable plan: what was detected, why, and what will change. */
export function formatSetupPlan({ detected, chosen, root, projectRoot, actions }) {
  const lines = [];
  lines.push(`Nullform setup — plan (nothing written yet)`);
  if (!detected.length) {
    lines.push(`  Detected: none. Pick a harness explicitly with --harness <${SUPPORTED_HARNESSES.filter((h) => !["all", "auto"].includes(h)).join("|")}>.`);
  } else {
    lines.push(`  Detected harnesses:`);
    for (const c of detected) {
      const mark = c.harness === chosen ? "*" : " ";
      lines.push(`   ${mark} ${c.harness}${c.reasons.length ? ` — ${c.reasons.join("; ")}` : ""}`);
    }
  }
  if (chosen) lines.push(`  Chosen target: ${chosen}`);
  if (root) lines.push(`  Install root:  ${root}`);
  if (projectRoot) lines.push(`  Project root:  ${projectRoot}`);
  if (actions?.length) {
    lines.push(`  Actions:`);
    for (const a of actions) lines.push(`   - ${a}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * R05/R06. `--dry-run` never writes; `--yes` skips the prompt but the plan is
 * always printed so an agent transcript contains what was decided.
 */
export async function runSetup(options = {}, deps = {}) {
  const { env, emit: baseEmit, userHome: baseHome } = commandContext(deps);
  const installFn = deps.installHarness || installHarness;
  const emit = (payload, text, toStderr = false) => baseEmit(options.json, payload, text, toStderr);
  const userHome = options.userHome ? resolve(options.userHome) : baseHome;
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : null;

  let detected = [];
  try {
    detected = discoverCandidatesDetailed({ userHome, projectRoot, env });
  } catch (error) {
    emit({ ok: false, error: "detection_failed", detail: sanitizeError(error.message) }, `setup error: ${sanitizeError(error.message)}\n`, true);
    return 1;
  }

  const explicit = options.harness ? String(options.harness) : null;
  if (explicit && !SUPPORTED_HARNESSES.includes(explicit)) {
    const msg = `Invalid --harness "${explicit}". Choose one of: ${SUPPORTED_HARNESSES.join(", ")}`;
    emit({ ok: false, error: "invalid_harness", detail: msg }, `setup error: ${msg}\n`, true);
    return 2;
  }

  let chosen = explicit;
  if (!chosen) {
    const saved = readInstallationState(userHome);
    if (saved?.harness && SUPPORTED_HARNESSES.includes(saved.harness)) chosen = saved.harness;
    else if (detected.length === 1) chosen = detected[0].harness;
  }

  if (!chosen) {
    const candidates = detected.map((c) => c.harness);
    const msg = candidates.length
      ? `Multiple candidate harnesses detected (${candidates.join(", ")}). Re-run with --harness <name> (or --yes to accept the first) : ${SUPPORTED_HARNESSES.join(", ")}`
      : `No supported harness detected. Specify --harness <name>. Choose one of: ${SUPPORTED_HARNESSES.join(", ")}`;
    // Ambiguity without --harness and without --yes fails closed (contract exit 2).
    if (!options.yes) {
      emit({ ok: false, error: "ambiguous_harness", candidates, detected, detail: msg }, `setup error: ${msg}\n`, true);
      return 2;
    }
    if (!candidates.length) {
      emit({ ok: false, error: "missing_harness", detected, detail: msg }, `setup error: ${msg}\n`, true);
      return 2;
    }
    chosen = candidates[0];
  }

  const root = options.root ? resolve(options.root) : DEFAULT_ROOT_HOME(chosen, userHome);
  const hostHome = options.hostHome
    ? resolve(options.hostHome)
    : resolveHostHome({ harness: chosen, userHome, env }).path;
  const actions = [
    `install ${chosen} adapter assets into ${root}`,
    `write harness config for ${chosen}${hostHome ? ` at ${hostHome}` : ""}`,
    `save installation state in ${join(userHome, ".nullform")}`,
  ];

  const plan = { detected, chosen, root, projectRoot, hostHome, actions };
  emit({ ok: true, dryRun: Boolean(options.dryRun), ...plan }, formatSetupPlan(plan));

  if (options.dryRun) return 0;

  if (!options.yes) {
    if (!options.isTTY) {
      const msg = "Refusing to write without confirmation in a non-interactive session. Re-run with --yes after reviewing the plan above.";
      emit({ ok: false, error: "confirmation_required", ...plan, detail: msg }, `setup error: ${msg}\n`, true);
      return 1;
    }
    // The plan was printed above; a human at a TTY can now answer.
    const answer = await deps.confirm?.(plan);
    if (answer === false) {
      emit({ ok: false, cancelled: true, ...plan }, "setup: cancelled by operator; nothing written.\n", true);
      return 1;
    }
  }

  try {
    const install = installFn({
      harness: chosen,
      root,
      ...(projectRoot ? { projectRoot } : {}),
      userHome,
      dryRun: false,
      hostHome,
      env,
    });
    // Persist installation identity: doctor/heal/update all resolve the target from it.
    // Without this, setup installed files but left the harness unmanageable.
    const state = {
      schemaVersion: 1,
      harness: chosen,
      root: resolve(install.root || root),
      ...(projectRoot ? { projectRoot } : {}),
      userHome,
      ...(hostHome ? { hostHome } : {}),
      version: readLocalVersion(),
      ...(install.managedFiles ? { managedFiles: install.managedFiles } : {}),
    };
    try {
      writeInstallationState(userHome, state);
    } catch (stateError) {
      const msg = sanitizeError(stateError.message);
      emit({ ok: false, error: "state_write_failed", ...plan, detail: msg }, `setup: files installed but state could not be saved: ${msg}\n`, true);
      return 1;
    }
    emit({ ok: true, ...plan, state, install: { root: install.root, files: install.filesToCopy?.length ?? null } }, `setup: installed ${chosen} at ${install.root || root}\n`);
    return 0;
  } catch (error) {
    const msg = sanitizeError(error.message);
    emit({ ok: false, error: "install_failed", ...plan, detail: msg }, `setup error: ${msg}\n`, true);
    return 1;
  }
}

/** Files whose recorded hash no longer matches: deleted or modified since install. */
function findDrift(managedFiles) {
  const drift = [];
  for (const [absPath, expected] of Object.entries(managedFiles || {})) {
    try {
      const actual = createHash("sha256").update(readFileSync(absPath)).digest("hex");
      if (actual !== expected) drift.push(absPath);
    } catch {
      drift.push(absPath); // missing or unreadable
    }
  }
  return drift;
}

/**
 * Restore drifted managed files from the installed package. Only paths that were
 * recorded as managed can be rewritten, and only when the package ships a byte
 * source for them; anything else is reported, never guessed.
 */
function restoreManagedFiles({ managedFiles, installRoot }) {
  const restored = [], skipped = [];
  for (const absPath of findDrift(managedFiles)) {
    const rel = relative(installRoot, absPath);
    if (!rel || rel.startsWith("..")) { skipped.push({ path: absPath, reason: "outside install root" }); continue; }
    const source = join(PACKAGE_ROOT, rel);
    if (!existsSync(source)) { skipped.push({ path: absPath, reason: "no package source" }); continue; }
    try {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, readFileSync(source));
      restored.push(absPath);
    } catch (error) {
      skipped.push({ path: absPath, reason: sanitizeError(error.message) });
    }
  }
  return { restored, skipped };
}

/** Repairs `heal` is allowed to perform. Anything else stops and reports. */
const REPAIR_ALLOWLIST = Object.freeze([
  "reapply-installation",
  "restore-managed-files",
]);

/**
 * R07. doctor → minimal allow-listed repairs → doctor again. Idempotent: a healthy
 * installation is a no-op. `--dry-run` lists repairs and writes nothing.
 */
export async function runHeal(options = {}, deps = {}) {
  const { env, emit: baseEmit, userHome: baseHome } = commandContext(deps);
  const doctorFn = deps.runDoctor || runDoctor;
  const installFn = deps.installHarness || installHarness;
  const emit = (payload, text, toStderr = false) => baseEmit(options.json, payload, text, toStderr);
  const userHome = options.userHome ? resolve(options.userHome) : baseHome;
  const saved = readInstallationState(userHome);
  if (!saved?.harness) {
    const msg = `No installation state at ${join(userHome, ".nullform", "installation.json")}. Run 'nullform setup' first.`;
    emit({ ok: false, error: "missing_state", detail: msg }, `heal error: ${msg}\n`, true);
    return 1;
  }

  const summary = (res) => {
    const checks = Array.isArray(res?.checks) ? res.checks : [];
    return {
      fail: checks.filter((c) => c.status === "fail").length,
      warn: checks.filter((c) => c.status === "warn").length,
    };
  };

  const doctorOptions = {
    // runDoctor: 'harness' is the installation ROOT PATH; the harness NAME is
    // 'targetHarness'. Passing them the other way round made heal report checks
    // that standalone 'nullform doctor' passes.
    harness: saved.root,
    targetHarness: saved.harness,
    userHome,
    hostHome: saved.hostHome,
    env,
    skipReleaseCheck: true,
  };

  const before = await doctorFn({ ...doctorOptions, mode: "installed" });
  const beforeCounts = summary(before);
  if (beforeCounts.fail === 0) {
    emit(
      { ok: true, noop: true, dryRun: Boolean(options.dryRun), action: "none", before: beforeCounts, after: beforeCounts, actions: [] },
      `heal: installation is healthy (0 fail, ${beforeCounts.warn} warn) — nothing to do.\n`,
    );
    return 0;
  }

  const actions = [];
  if (existsSync(resolve(doctorOptions.root || ""))) actions.push("reapply-installation");
  const drift = findDrift(saved.managedFiles);
  if (drift.length) actions.push("restore-managed-files");

  const planned = actions.filter((a) => REPAIR_ALLOWLIST.includes(a));
  const refused = actions.filter((a) => !REPAIR_ALLOWLIST.includes(a));

  if (options.dryRun) {
    emit(
      { ok: true, dryRun: true, before: beforeCounts, planned, refused, actions: planned },
      `heal [dry-run]: ${beforeCounts.fail} fail, ${beforeCounts.warn} warn.\n  would: ${planned.join(", ") || "nothing allow-listed"}${refused.length ? `\n  refused (not allow-listed): ${refused.join(", ")}` : ""}\n`,
    );
    return 0;
  }

  if (!planned.length) {
    const msg = `No allow-listed repair applies to ${beforeCounts.fail} failing check(s); refusing to improvise.`;
    emit({ ok: false, error: "no_allowlisted_repair", before: beforeCounts, refused, detail: msg }, `heal error: ${msg}\n`, true);
    return 1;
  }

  const applied = [];
  const skipped = [];
  try {
    for (const action of planned) {
      if (action === "restore-managed-files") {
        const res = restoreManagedFiles({ managedFiles: saved.managedFiles, installRoot: resolve(saved.root) });
        applied.push(`restore-managed-files (${res.restored.length} restored, ${res.skipped.length} skipped)`);
        if (res.skipped.length) skipped.push(...res.skipped);
        continue;
      }
      if (action === "reapply-installation") {
        installFn({
          harness: saved.harness,
          root: doctorOptions.root,
          ...(saved.projectRoot ? { projectRoot: saved.projectRoot } : {}),
          userHome,
          dryRun: false,
          hostHome: saved.hostHome,
          managedFiles: saved.managedFiles,
          env,
        });
        applied.push(action);
      }
    }
  } catch (error) {
    const msg = sanitizeError(error.message);
    emit({ ok: false, error: "repair_failed", before: beforeCounts, actions: applied, detail: msg }, `heal error: ${msg}\n`, true);
    return 1;
  }

  const after = await doctorFn({ ...doctorOptions, mode: "installed" });
  const afterCounts = summary(after);
  const ok = afterCounts.fail === 0;
  emit(
    { ok, before: beforeCounts, after: afterCounts, actions: applied, skipped },
    `heal: ${ok ? "repaired" : "still failing"} — fail ${beforeCounts.fail} -> ${afterCounts.fail}, warn ${beforeCounts.warn} -> ${afterCounts.warn} (applied: ${applied.join(", ")}).\n`,
    !ok,
  );
  return ok ? 0 : 1;
}
