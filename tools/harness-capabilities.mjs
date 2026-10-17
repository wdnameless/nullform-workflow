/**
 * tools/harness-capabilities.mjs — Explicit capability boundaries, host presence detection,
 * doctor capability statuses, and automated review execution gates.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { CONCRETE_HARNESSES, readInstallationState, compareSemVer } from "./installation-state.mjs";
import { isCommandInPath } from "./harness-config.mjs";
import { inspectHarness } from "./harness-profiles.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const REPO_ROOT = resolve(__dirname, "..");

export function getHostPresence() {
  return {
    claude: isCommandInPath("claude"),
    codex: isCommandInPath("codex"),
    opencode: isCommandInPath("opencode"),
    cursor: isCommandInPath("cursor"),
    omp: isCommandInPath("omp"),
    openclaw: isCommandInPath("openclaw"),
    hermes: isCommandInPath("hermes"),
    openhuman: isCommandInPath("openhuman") || isCommandInPath("openhuman-core"),
    bun: isCommandInPath("bun"),
    node: true,
  };
}

export function getCapabilitiesInfo({ userHome = homedir(), env = process.env, harness, hostHome, hostManifest, projectRoot, platform = process.platform, probe = false } = {}) {
  const hostPresence = getHostPresence();
  const adapters = CONCRETE_HARNESSES.map((id) => ({
    id,
    configuration: true,
    automatedReview: id === "omp",
    present: Boolean(hostPresence[id]),
  }));

  return {
    ok: true,
    configurationAdapters: [...CONCRETE_HARNESSES],
    adapters,
    customHostContract: {
      schemaVersion: 1, supported: true, requires: ["hostManifest", "projectRoot"],
      evidence: "declared", runtimeLoading: "not-verified", executableCommands: false,
    },
    ...(harness ? { profile: inspectHarness({ harness, userHome, env, hostHome, hostManifest, projectRoot, platform, probe }) } : {}),
    coreWorkflowGates: {
      supported: true,
      runtime: "node",
      requiresOmp: false,
      requiresBun: false,
      commands: ["start", "suggest", "artifact", "check", "status", "close", "check-ci", "stage-b", "metrics"],
    },
    automatedReview: {
      supportedHarnesses: ["omp"],
      unsupportedHarnesses: [...CONCRETE_HARNESSES.filter((h) => h !== "omp"), "custom"],
      requiresBun: true,
      requiresOmp: true,
      status: "omp_only",
    },
    hostPresence,
  };
}

export function validateReviewCapability(targetHarness, { dryRun = false, userHome = null } = {}) {
  let norm = targetHarness ? String(targetHarness).trim().toLowerCase() : null;
  if (!norm && userHome) {
    try {
      const savedState = readInstallationState(userHome);
      if (savedState?.harness) norm = savedState.harness.toLowerCase();
    } catch {}
  }
  if (!norm) {
    try {
      const home = process.env.NULLFORM_USER_HOME || process.env.USERPROFILE || process.env.HOME || homedir();
      const savedState = readInstallationState(home);
      if (savedState?.harness) norm = savedState.harness.toLowerCase();
    } catch {}
  }
  if (norm && norm !== "omp") {
    return {
      ok: false,
      error: `workflow review-run: harness '${norm}' does not support automated review. Automated review execution is only supported for 'omp' with Bun; all 8 adapters support configuration deployment.`,
    };
  }
  if (!dryRun && !isCommandInPath("bun")) {
    return {
      ok: false,
      error: "workflow review-run: automated review execution requires Bun and OMP, but 'bun' was not found in PATH.",
    };
  }
  return { ok: true, harness: norm || "omp" };
}

export function checkVersionAlignment({ harness, userHome, packageRoot = REPO_ROOT, activePid = null }) {
  let pkgVersion = null;
  try {
    const pkgVerFile = join(resolve(packageRoot), "VERSION");
    if (existsSync(pkgVerFile)) pkgVersion = readFileSync(pkgVerFile, "utf8").trim();
  } catch {}

  let savedState = null;
  if (userHome) {
    try {
      savedState = readInstallationState(userHome);
    } catch {}
  }

  let uncommittedJournal = false;
  if (userHome) {
    try {
      const journalFile = join(resolve(userHome), ".nullform", "deployment-journal.json");
      if (existsSync(journalFile)) {
        const parsed = JSON.parse(readFileSync(journalFile, "utf8"));
        if (parsed.status === "in-progress" || parsed.status === "rolling-back") {
          if (parsed.pid && parsed.pid === (activePid || process.pid)) {
            uncommittedJournal = false;
          } else {
            uncommittedJournal = true;
          }
        }
      }
    } catch {}
  }

  const targetVer =
    savedState?.version ||
    (existsSync(join(harness, "VERSION")) ? readFileSync(join(harness, "VERSION"), "utf8").trim() : null);

  if (uncommittedJournal) {
    return {
      id: "version-alignment",
      status: "warn",
      divergence: "recoverable",
      recoverable: true,
      detail:
        "Обнаружен незавершённый журнал деплоя от прерванной установки; состояние восстановимо через 'nullform init' или 'nullform update'.",
    };
  }

  if (pkgVersion && targetVer) {
    const cmp = compareSemVer(pkgVersion, targetVer);
    if (cmp > 0) {
      return {
        id: "version-alignment",
        status: "warn",
        divergence: "pending",
        pending: true,
        detail: `Бинарник пакета (v${pkgVersion}) новее проверенной установки (v${targetVer}). Повторное применение таргета ожидает завершения (pending/recoverable); запустите 'nullform update' или 'nullform init'.`,
      };
    }
    if (cmp < 0) {
      return {
        id: "version-alignment",
        status: "warn",
        divergence: "older_binary",
        detail: `Бинарник пакета (v${pkgVersion}) старше проверенной установки (v${targetVer}). Обновите бинарник пакета или запустите 'nullform init'.`,
      };
    }
    return {
      id: "version-alignment",
      status: "pass",
      detail: `Версия таргета (v${targetVer}) согласуется с бинарником пакета (v${pkgVersion}).`,
    };
  }

  if (targetVer) {
    return {
      id: "version-alignment",
      status: "pass",
      detail: `Установка таргета проверена на v${targetVer}.`,
    };
  }

  return {
    id: "version-alignment",
    status: "skip",
    detail: "Версия установки не определена.",
  };
}

export function checkHarnessCapabilities(targetHarness, options = {}) {
  const automatedReviewSupported = targetHarness === "omp";
  return {
    id: "harness-capabilities",
    status: "pass",
    automatedReviewSupported,
    ...(options.userHome ? { profile: inspectHarness({ ...options, harness: targetHarness }) } : {}),
    detail: `Конфигурация поддерживается для 8 именованных адаптеров и декларативного custom-контракта (не доказательство загрузки/исполнения); базовые гейты Node-native; автоматическое ревью ${
      automatedReviewSupported ? "поддерживается (omp)" : `не поддерживается для '${targetHarness}' (только omp с Bun)`
    }.`,
  };
}
export function printWorkflowHelp() {
  console.log("workflow.mjs — tier enforcement\n");
  console.log("  node workflow.mjs suggest --files a.ts,b.ts [--task \"...\"]");
  console.log("  node workflow.mjs start --tier T2 --task \"add rate limiting\"");
  console.log("  node workflow.mjs start --tier T0 --auto --allow \"src/**\" --max-diff 5");
  console.log("  node workflow.mjs artifact --kind manifest --path openspec/changes/x/manifest.md");
  console.log("  node workflow.mjs check      # exit 1 if the tier's artifacts are missing");
  console.log("  node workflow.mjs status");
  console.log("  node workflow.mjs check-budget [--sessions <dir>] [--json]");
  console.log("  node workflow.mjs escalate --tier T2");
  console.log("  node workflow.mjs close [--force --reason \"...\"] [--auto] [--diff-lines N]");
  console.log("  node workflow.mjs metrics [--root .]");
  console.log("  nullform workflow workspace --feature SLUG [--root PROJECT]  # new detached writer");
  console.log("  nullform workflow integrate --feature SLUG [--root PROJECT]  # serialized native merge");
  console.log("\nTiers: T0 lane · T1 +recon · T2 +manifest/openspec/interfaces/oracle · T3 +worktree");
  console.log("  node workflow.mjs check-ci --tier T2 --change <name>");
  console.log("  node workflow.mjs check-ci --push --base-ref <previous-commit>");
  console.log("  node workflow.mjs review-run --role <reviewer|oracle> --change <name> --model <provider/model> --base-ref <base> [--product-command <JSON argv>] [--redo]");
  console.log("  node workflow.mjs stage-b --change <name> --phase <before|after> --test-cmd \"<cmd>\" [--disposition <lean-already|simplified>] [--test-timeout <sec>]");
}
