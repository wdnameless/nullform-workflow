#!/usr/bin/env node
/**
 * tools/self-update.mjs — release drift check and notify-plus-command self-update.
 *
 * Usage:
 *   node tools/self-update.mjs check [--root <dir>] [--api-url <url>] [--json]
 *   node tools/self-update.mjs update [--dry-run] [--root <dir>] [--api-url <url>] [--json]
 *   node tools/self-update.mjs --help
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

export const DEFAULT_RELEASE_API =
  "https://api.github.com/repos/wdnameless/nullform-workflow/releases/latest";
export const DEFAULT_TIMEOUT_MS = 10000;

export function parseSemVer(v) {
  if (!v || typeof v !== "string") return null;
  const clean = v.trim().replace(/^v/i, "");
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    raw: clean,
  };
}

export function compareSemVer(a, b) {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && pb.prerelease) {
    if (pa.prerelease < pb.prerelease) return -1;
    if (pa.prerelease > pb.prerelease) return 1;
  }
  return 0;
}

export function readLocalVersion(root = REPO_ROOT) {
  const versionPath = join(root, "VERSION");
  if (!existsSync(versionPath)) return null;
  try {
    return readFileSync(versionPath, "utf8").trim();
  } catch {
    return null;
  }
}

export async function checkRelease(options = {}) {
  const root = resolve(options.root || REPO_ROOT);
  const apiUrl =
    options.apiUrl ||
    process.env.NULLFORM_RELEASE_URL ||
    DEFAULT_RELEASE_API;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn || globalThis.fetch;

  const localRaw = readLocalVersion(root);
  if (!localRaw) {
    return {
      status: "setup",
      ok: true,
      offline: false,
      missingVersion: true,
      current: null,
      latest: null,
      detail: `VERSION file missing in ${root}`,
    };
  }

  const localSem = parseSemVer(localRaw);
  const current = localSem ? localSem.raw : localRaw;

  let res;
  try {
    res = await fetchFn(apiUrl, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "nullform-workflow-self-update",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      status: "setup",
      ok: true,
      offline: true,
      current,
      latest: null,
      error: err.message,
      detail: `GitHub releases API unreachable: ${err.message}`,
    };
  }

  if (res.status === 404) {
    return {
      status: "setup",
      ok: true,
      offline: false,
      current,
      latest: null,
      detail: "No releases found on GitHub repository",
    };
  }

  if (!res.ok) {
    return {
      status: "setup",
      ok: true,
      offline: true,
      current,
      latest: null,
      detail: `GitHub API returned HTTP ${res.status}`,
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return {
      status: "setup",
      ok: true,
      offline: false,
      current,
      latest: null,
      detail: `Failed to parse GitHub response: ${err.message}`,
    };
  }

  const tag = data.tag_name || data.name || "";
  const remoteSem = parseSemVer(tag);
  if (!remoteSem) {
    return {
      status: "setup",
      ok: true,
      offline: false,
      current,
      latest: null,
      detail: `Could not parse release tag: "${tag}"`,
    };
  }

  const latest = remoteSem.raw;
  const cmp = compareSemVer(current, latest);
  const normalizedTag = tag.startsWith("v") || tag.startsWith("V") ? tag : `v${latest}`;

  if (cmp < 0) {
    return {
      status: "drift",
      ok: true,
      drift: true,
      current,
      latest,
      tag: normalizedTag,
      releaseUrl: data.html_url || null,
      publishedAt: data.published_at || null,
      detail: `Update available: local v${current} is behind remote v${latest} (${normalizedTag})`,
    };
  }

  return {
    status: "clean",
    ok: true,
    drift: false,
    current,
    latest,
    tag: normalizedTag,
    detail: `Up to date: v${current} matches latest release v${latest}`,
  };
}

export function runGit(args, cwd, spawnFn = spawnSync) {
  const res = spawnFn("git", args, { cwd, encoding: "utf8" });
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
    error: res.error,
  };
}

export function checkWorkingTreeClean(root, spawnFn = spawnSync) {
  const statusRes = runGit(["status", "--porcelain"], root, spawnFn);
  if (statusRes.status !== 0) {
    return {
      clean: false,
      error: `Failed to run git status: ${statusRes.stderr}`,
      dirtyLines: [],
    };
  }
  const lines = statusRes.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const dirtyLines = lines.filter((l) => !l.startsWith("??"));
  return {
    clean: dirtyLines.length === 0,
    dirtyLines,
  };
}

export async function executeUpdate(options = {}) {
  const root = resolve(options.root || REPO_ROOT);
  const spawnFn = options.spawnFn || spawnSync;

  const gitCheck = runGit(["rev-parse", "--is-inside-work-tree"], root, spawnFn);
  if (gitCheck.status !== 0) {
    return {
      ok: false,
      error: "not_a_git_repo",
      detail: `Directory ${root} is not inside a git repository.`,
      instructions: ["Ensure you are running inside a git clone of nullform-workflow."],
    };
  }

  const treeCheck = checkWorkingTreeClean(root, spawnFn);
  if (!treeCheck.clean) {
    return {
      ok: false,
      error: "dirty_tree",
      detail: `Working tree has ${treeCheck.dirtyLines.length} uncommitted change(s).`,
      dirtyLines: treeCheck.dirtyLines,
      instructions: [
        "git status",
        "git stash  # or: git commit -m 'save local changes'",
        "node tools/self-update.mjs update",
        "git stash pop  # to restore saved changes",
      ],
    };
  }

  let targetTag = options.targetTag;
  let check = null;

  if (!targetTag) {
    check = await checkRelease(options);
    if (check.status === "setup") {
      return {
        ok: false,
        error: "release_check_failed",
        detail: check.detail || "Unable to determine latest release from GitHub",
      };
    }
    if (check.status === "clean" && !options.force) {
      return {
        ok: true,
        updated: false,
        current: check.current,
        latest: check.latest,
        detail: `Already up to date (v${check.current}).`,
      };
    }
    targetTag = check.tag;
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      current: check ? check.current : readLocalVersion(root),
      targetTag,
      latest: check ? check.latest : targetTag.replace(/^v/i, ""),
      plan: [
        `git fetch origin tag ${targetTag}`,
        `git merge --ff-only ${targetTag}`,
        `node tools/install-harness.mjs --dry-run`,
        `node tools/doctor.mjs`,
      ],
      detail: `[dry-run] Update plan for ${targetTag} ready. No changes written.`,
    };
  }

  const fetchRes = runGit(["fetch", "origin", "tag", targetTag], root, spawnFn);
  if (fetchRes.status !== 0) {
    const fetchAllRes = runGit(["fetch", "origin", "--tags"], root, spawnFn);
    if (fetchAllRes.status !== 0) {
      return {
        ok: false,
        error: "fetch_failed",
        detail: `git fetch failed: ${fetchRes.stderr || fetchAllRes.stderr}`,
        instructions: [`git fetch origin`, `git merge --ff-only ${targetTag}`],
      };
    }
  }

  const ancestorRes = runGit(["merge-base", "--is-ancestor", "HEAD", targetTag], root, spawnFn);
  if (ancestorRes.status !== 0) {
    return {
      ok: false,
      error: "non_fast_forward",
      detail: `Cannot fast-forward HEAD to ${targetTag}. Local branch has diverged.`,
      instructions: [
        "git fetch origin",
        `git merge ${targetTag}  # resolve conflicts manually`,
        "node tools/install-harness.mjs",
        "node tools/doctor.mjs",
      ],
    };
  }

  const mergeRes = runGit(["merge", "--ff-only", targetTag], root, spawnFn);
  if (mergeRes.status !== 0) {
    return {
      ok: false,
      error: "merge_failed",
      detail: `git merge --ff-only ${targetTag} failed: ${mergeRes.stderr}`,
      instructions: [`git merge ${targetTag}`],
    };
  }

  const installScript = join(root, "tools", "install-harness.mjs");
  let installOk = true;
  if (existsSync(installScript)) {
    const instRes = spawnFn(process.execPath, [installScript, "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    if (instRes.status !== 0) installOk = false;
  }

  const doctorScript = join(root, "tools", "doctor.mjs");
  let doctorOk = true;
  if (existsSync(doctorScript)) {
    const docRes = spawnFn(process.execPath, [doctorScript, "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    if (docRes.status !== 0) doctorOk = false;
  }

  return {
    ok: true,
    updated: true,
    from: check ? check.current : null,
    to: check ? check.latest : targetTag.replace(/^v/i, ""),
    tag: targetTag,
    installOk,
    doctorOk,
    detail: `Successfully updated to ${targetTag}.`,
  };
}

export function parseCliArgs(args) {
  let command = "check";
  let json = false;
  let dryRun = false;
  let force = false;
  let root = null;
  let apiUrl = null;
  let timeout = null;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "check" || arg === "update") {
      command = arg;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--root") {
      root = args[++i];
    } else if (arg === "--api-url") {
      apiUrl = args[++i];
    } else if (arg === "--timeout") {
      timeout = parseInt(args[++i], 10) * 1000;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return {
    command,
    json,
    dryRun,
    force,
    root: root ? resolve(root) : REPO_ROOT,
    apiUrl,
    timeoutMs: timeout || DEFAULT_TIMEOUT_MS,
    help,
  };
}

function printHelp() {
  console.log(`
NULLFORM WORKFLOW Self-Update

Usage:
  node tools/self-update.mjs check [options]
  node tools/self-update.mjs update [options]

Commands:
  check     Check local VERSION against latest GitHub release
  update    Fast-forward to latest release and run idempotent install + doctor

Options:
  --dry-run          Preview update plan without making changes (update only)
  --json             Output result as JSON
  --root <dir>       Repository root directory
  --api-url <url>    Override GitHub releases API URL
  --timeout <sec>    Network timeout in seconds (default: 10)
  --force            Force update even if clean
  --help, -h         Show this help message
`.trim());
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.command === "check") {
    const res = await checkRelease(opts);
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      if (res.status === "drift") {
        console.log(`self-update: drift — local v${res.current} is behind remote v${res.latest} (${res.tag})`);
        console.log(`To update, run: node tools/self-update.mjs update`);
      } else if (res.status === "clean") {
        console.log(`self-update: clean — local v${res.current} is up to date.`);
      } else {
        console.log(`self-update: setup — ${res.detail}`);
      }
    }
    return 0;
  }

  if (opts.command === "update") {
    const res = await executeUpdate(opts);
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      if (!res.ok) {
        console.error(`self-update error: [${res.error}] ${res.detail}`);
        if (res.instructions && res.instructions.length > 0) {
          console.error("\nManual resolution instructions:");
          for (const instr of res.instructions) {
            console.error(`  ${instr}`);
          }
        }
      } else if (res.dryRun) {
        console.log(`[dry-run] Update plan for ${res.targetTag}:`);
        for (const step of res.plan) {
          console.log(`  - ${step}`);
        }
      } else if (res.updated) {
        console.log(`self-update: successfully updated from v${res.from} to ${res.tag}.`);
      } else {
        console.log(`self-update: ${res.detail}`);
      }
    }
    return res.ok ? 0 : 1;
  }

  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    process.stderr.write(`self-update: unhandled error: ${err.message}\n`);
    process.exitCode = 2;
  });
}
