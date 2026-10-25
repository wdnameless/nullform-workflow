#!/usr/bin/env node
/**
 * tools/verify-shared.mjs — общие хелперы verify/audit профилей (выделены из монолита 1:1).
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

export class NotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export function runProc(cmd, args = [], options = {}) {
  const isWin = process.platform === "win32";
  return spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: isWin,
    ...options,
  });
}

/**
 * prompt-lint also scans the agents home, so it must resolve the SAME home being
 * verified. Without this, checking a sandbox harness compares against the
 * operator's real ~/.agents baseline and reports drift that is not there.
 */
export function runPromptLint(tool, userHome, args) {
  return runProc(process.execPath, [tool, ...args], {
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome },
  });
}

export function checkSyncDrift(repoRoot, harnessRoot, userHome) {
  const isWin = process.platform === "win32";
  const syncScript = isWin
    ? join(repoRoot, "tools", "sync.ps1")
    : join(repoRoot, "tools", "sync.sh");

  if (!existsSync(syncScript)) {
    return { ok: true, detail: "n/a (no sync tool)" };
  }
  if (!existsSync(join(repoRoot, "install.ps1"))) {
    return { ok: true, detail: "n/a (standalone install)" };
  }

  // Pin the agents root and agent dir to the user home being verified: without
  // it the sync scripts compare against the host ~/.agents and ~/.omp/agent.
  const agentsRoot = userHome ? join(userHome, ".agents") : "";
  const agentDir = userHome ? join(userHome, ".omp", "agent") : "";
  const env = userHome ? { ...process.env, ...(agentsRoot ? { AGENTS_ROOT: agentsRoot } : {}), ...(agentDir ? { AGENT_DIR: agentDir } : {}) } : undefined;
  const envOpt = env ? { env } : {};
  let r;
  if (isWin) {
    r = runProc("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", syncScript, "-HarnessRoot", harnessRoot,
      ...(repoRoot ? ["-RepoRoot", repoRoot] : []),
      ...(agentsRoot ? ["-AgentsRoot", agentsRoot] : []), ...(agentDir ? ["-AgentDir", agentDir] : []),
    ], envOpt);
  } else {
    r = runProc(syncScript, [
      "--harness-root", harnessRoot,
      ...(repoRoot ? ["--repo", repoRoot] : []),
      ...(agentsRoot ? ["--agents-root", agentsRoot] : []), ...(agentDir ? ["--agent-dir", agentDir] : []),
    ], envOpt);
  }
  const text = (r.stdout || "") + (r.stderr || "");
  if (/sync:\s*clean/.test(text)) {
    return { ok: true, detail: "clean" };
  }
  if (/Cannot locate workflow-repo/.test(text)) {
    return { ok: true, detail: "n/a (no repo clone)" };
  }
  return {
    ok: false,
    detail: `files drifted - run sync.${isWin ? "ps1" : "sh"} -Promote or -Deploy`,
    error: "agent defs/rules differ between harness and repo",
  };
}

export function checkSkillsDoctor(harnessRoot, userHome, repoRoot) {
  const tool = join(harnessRoot, "tools", "skills-doctor.mjs");
  return runProc(process.execPath, [
    tool,
    "--installed",
    join(userHome, ".agents", "skills"),
    "--repo",
    join(repoRoot, "skills"),
    "--agents-home",
    join(userHome, ".agents"),
  ]);
}

export function testTierGate(harnessRoot, strict = true) {
  const wf = join(harnessRoot, "tools", "workflow.mjs");
  if (!existsSync(wf)) {
    throw new Error(
      strict ? "workflow.mjs missing" : "workflow.mjs missing - the protocol is back to being prose"
    );
  }
  const tmp = mkdtempSync(join(tmpdir(), "wf-"));
  try {
    const env = { ...process.env, NF_NO_DASHBOARD: "1" };
    const s0 = runProc(process.execPath, [wf, "start", "--tier", "T0", "--task", "probe", "--root", tmp], { env });
    if (s0.status !== 0) throw new Error(`start T0 failed, got exit ${s0.status}`);
    const t0 = runProc(process.execPath, [wf, "check", "--root", tmp], { env });
    if (t0.status !== 0) throw new Error(`T0 should require no artifacts, got exit ${t0.status}`);

    const c0 = runProc(process.execPath, [wf, "close", "--root", tmp], { env });
    if (c0.status !== 0) throw new Error(`close T0 failed, got exit ${c0.status}`);

    const s2 = runProc(process.execPath, [wf, "start", "--tier", "T2", "--task", "probe2", "--root", tmp], { env });
    if (s2.status !== 0) throw new Error(`start T2 failed, got exit ${s2.status}`);
    const t2 = runProc(process.execPath, [wf, "check", "--root", tmp], { env });
    if (t2.status === 0) throw new Error("T2 passed with no artifacts - the gate does not work");

    if (strict) {
      const fake = runProc(process.execPath, [wf, "artifact", "--kind", "manifest", "--path", "nope/missing.md", "--root", tmp], { env });
      if (fake.status === 0) throw new Error("a non-existent artifact path was accepted");
      const close = runProc(process.execPath, [wf, "close", "--root", tmp], { env });
      if (close.status === 0) throw new Error("an incomplete tier was closed without --force");
      const forced = runProc(process.execPath, [wf, "close", "--force", "--reason", "probe", "--root", tmp], { env });
      if (forced.status !== 0) throw new Error("--force --reason should close");
      return "T0 passes, T2 blocks, fake paths rejected, forced close recorded";
    }
    return "T0 passes, T2 blocks";
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/** Map a check's return value to a status.
 *
 * A check that returned nothing conclusive is UNVERIFIED, not passed: the previous default
 * (`res.status || "PASS"`) meant a forgotten verdict, `{}` or `{ok: undefined}` all counted
 * as a pass, so a runner that decides nothing reported agreement.
 */
export function classifyResult(res) {
  if (typeof res === "string") return { status: "PASS", detail: res };
  if (typeof res === "boolean") return { status: res ? "PASS" : "FAIL", detail: res ? "True" : "False" };
  if (!res || typeof res !== "object") return { status: "UNVERIFIED", detail: "" };
  const detail = res.detail ?? "";
  if (res.ok === true) return { status: "PASS", detail };
  if (res.ok === false) return { status: "FAIL", detail };
  if (typeof res.status === "string" && res.status.trim()) return { status: res.status, detail };
  return { status: "UNVERIFIED", detail };
}

export async function executeCheck(id, label, fn) {
  const start = Date.now();
  try {
    const res = await fn();
    const { status, detail } = classifyResult(res);
    return {
      id,
      label,
      status,
      detail,
      ms: Date.now() - start,
    };
  } catch (err) {
    const ms = Date.now() - start;
    if (err instanceof NotConfiguredError || err.name === "NotConfiguredError") {
      return {
        id,
        label,
        status: "SETUP",
        detail: err.message,
        ms,
      };
    }
    return {
      id,
      label,
      status: "FAIL",
      detail: err.message || String(err),
      ms,
    };
  }
}
export function invokeDoctor(harnessRoot, agentDir, userHome) {
  const doc = join(harnessRoot, "tools", "doctor.mjs");
  if (!existsSync(doc)) return { exists: false };
  const args = [doc, "--harness", harnessRoot];
  if (agentDir) args.push("--agent-dir", agentDir);
  if (userHome) args.push("--agents-home", join(userHome, ".agents"));
  args.push("--json");
  return { exists: true, res: runProc(process.execPath, args) };
}
