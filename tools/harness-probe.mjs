/**
 * tools/harness-probe.mjs — Probe CLI harness installations and versions.
 *
 * Clean-room reimplementation of harness probing concepts inspired by free-claude-code;
 * zero copied code (MIT licensed).
 */

import { spawnSync } from "node:child_process";

export function defaultRunner(cmd, args = []) {
  try {
    const res = spawnSync(cmd, args, {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      status: res.status ?? null,
      stdout: String(res.stdout ?? ""),
      stderr: String(res.stderr ?? ""),
      error: res.error ?? null,
    };
  } catch (err) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: err,
    };
  }
}

export function satisfiesMin(version, min) {
  if (!version || !min) return false;
  const vMatch = String(version).match(/(\d+)\.(\d+)\.(\d+)/);
  const mMatch = String(min).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!vMatch || !mMatch) return false;
  const v = [Number(vMatch[1]), Number(vMatch[2]), Number(vMatch[3])];
  const m = [Number(mMatch[1]), Number(mMatch[2]), Number(mMatch[3])];
  for (let i = 0; i < 3; i++) {
    if (v[i] > m[i]) return true;
    if (v[i] < m[i]) return false;
  }
  return true;
}

export function probeHarness(entry, runner = defaultRunner) {
  const base = entry?.id ? { id: entry.id } : {};
  if (!entry?.detect?.cmd) {
    return { ...base, installed: false, version: null, status: "not_installed", compatible: false };
  }
  const cmd = entry.detect.cmd;
  const args = entry.versions?.args || ["--version"];
  let res;
  try {
    res = runner(cmd, args);
  } catch (err) {
    res = { status: null, stdout: "", stderr: "", error: err };
  }

  if (res?.error?.code === "ENOENT" || res?.status === 127) {
    return { ...base, installed: false, version: null, status: "not_installed", compatible: false };
  }

  const isTimeout =
    res?.error?.code === "ETIMEDOUT" ||
    res?.error?.name === "TimeoutError" ||
    Boolean(res?.timedOut) ||
    (res?.status === null && res?.signal === "SIGTERM");
  if (isTimeout) {
    return { ...base, installed: false, version: null, status: "timeout", compatible: false };
  }

  const output = `${res?.stdout || ""}\n${res?.stderr || ""}`;
  const match = output.match(/(\d+\.\d+\.\d+)/);
  const version = match ? match[1] : null;

  if (res?.error || (res?.status !== 0 && res?.status !== null && !version)) {
    return { ...base, installed: false, version: null, status: "failed", compatible: false };
  }

  if (!version) {
    return { ...base, installed: true, version: null, status: "unrecognized_version", compatible: false };
  }

  const min = entry.versions?.min;
  const compatible = min ? satisfiesMin(version, min) : true;
  const result = { ...base, installed: true, version,
    status: compatible ? "available" : "unavailable", compatible };
  const act = entry.activation;
  if (act && Array.isArray(act.args) && compatible) {
    result.activated = checkActivation(cmd, act, runner);
  }
  return result;
}

function checkActivation(cmd, act, runner) {
  let res;
  try {
    res = runner(cmd, act.args);
  } catch {
    return false;
  }
  if (res?.error || res?.status !== 0) return false;
  const out = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
  if (act.expect === "contains") return out.length > 0;
  if (typeof act.expect === "string") return out.includes(act.expect);
  return res.status === 0;
}
