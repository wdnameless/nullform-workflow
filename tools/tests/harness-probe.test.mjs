import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeHarness, satisfiesMin, defaultRunner } from "../harness-probe.mjs";
import { runDoctorCommand } from "../../bin/nullform.mjs";

test("satisfiesMin correctly evaluates semver triples without deps", () => {
  assert.equal(satisfiesMin("0.20.4", "0.20.4"), true);
  assert.equal(satisfiesMin("0.20.5", "0.20.4"), true);
  assert.equal(satisfiesMin("0.21.0", "0.20.4"), true);
  assert.equal(satisfiesMin("1.0.0", "0.20.4"), true);
  assert.equal(satisfiesMin("v0.20.4", "0.20.4"), true);
  assert.equal(satisfiesMin("0.20.3", "0.20.4"), false);
  assert.equal(satisfiesMin("0.19.9", "0.20.4"), false);
  assert.equal(satisfiesMin("0.0.1", "0.20.4"), false);
  assert.equal(satisfiesMin(null, "0.20.4"), false);
  assert.equal(satisfiesMin("0.20.4", null), false);
});

test("probeHarness fixture: installed + version", () => {
  const entry = { id: "hermes", detect: { cmd: "hermes" } };
  const runner = () => ({ status: 0, stdout: "hermes 0.22.5\n", stderr: "" });
  const res = probeHarness(entry, runner);
  assert.equal(res.installed, true);
  assert.equal(res.version, "0.22.5");
  assert.equal(res.status, "available");
  assert.equal(res.compatible, true);
});

test("probeHarness fixture: not_installed (ENOENT or missing cmd)", () => {
  const entry = { id: "missing", detect: { cmd: "missing-bin" } };
  const runner = () => ({ status: null, error: { code: "ENOENT" }, stdout: "", stderr: "" });
  const res = probeHarness(entry, runner);
  assert.equal(res.installed, false);
  assert.equal(res.version, null);
  assert.equal(res.status, "not_installed");
  assert.equal(res.compatible, false);

  const missingCmd = { id: "no-cmd", detect: {} };
  const res2 = probeHarness(missingCmd, runner);
  assert.equal(res2.installed, false);
  assert.equal(res2.status, "not_installed");
});

test("probeHarness fixture: timeout", () => {
  const entry = { id: "slow", detect: { cmd: "slow-bin" } };
  const runner = () => ({ status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" });
  const res = probeHarness(entry, runner);
  assert.equal(res.installed, false);
  assert.equal(res.version, null);
  assert.equal(res.status, "timeout");
  assert.equal(res.compatible, false);
});

test("probeHarness fixture: bad-version (unrecognized semver)", () => {
  const entry = { id: "no-ver", detect: { cmd: "tool" } };
  const runner = () => ({ status: 0, stdout: "running tool version dev-build", stderr: "" });
  const res = probeHarness(entry, runner);
  assert.equal(res.installed, true);
  assert.equal(res.version, null);
  assert.equal(res.status, "unrecognized_version");
  assert.equal(res.compatible, false);
});

test("probeHarness fixture: execution failed without version", () => {
  const entry = { id: "broken", detect: { cmd: "broken-bin" } };
  const runner = () => ({ status: 1, stdout: "", stderr: "fatal error" });
  const res = probeHarness(entry, runner);
  assert.equal(res.installed, false);
  assert.equal(res.version, null);
  assert.equal(res.status, "failed");
  assert.equal(res.compatible, false);
});

test("probeHarness fixture: min version pass and fail", () => {
  const entry = {
    id: "hermes",
    detect: { cmd: "hermes" },
    versions: { min: "0.20.4", args: ["--version"] },
  };

  // Pass (version >= min)
  const passRunner = () => ({ status: 0, stdout: "hermes 0.21.0\n", stderr: "" });
  const passRes = probeHarness(entry, passRunner);
  assert.equal(passRes.installed, true);
  assert.equal(passRes.version, "0.21.0");
  assert.equal(passRes.status, "available");
  assert.equal(passRes.compatible, true);

  // Fail (version < min)
  const failRunner = () => ({ status: 0, stdout: "hermes 0.19.8\n", stderr: "" });
  const failRes = probeHarness(entry, failRunner);
  assert.equal(failRes.installed, true);
  assert.equal(failRes.version, "0.19.8");
  assert.equal(failRes.status, "unavailable");
  assert.equal(failRes.compatible, false);
});

test("probeHarness fixture: activation check pass/fail/skip", () => {
  const entry = { id: "hermes", detect: { cmd: "hermes" },
    versions: { min: "0.20.4", args: ["--version"] },
    activation: { args: ["config", "get", "model.provider", "--json"], expect: "contains" } };
  const calls = [];
  const okRunner = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (args[0] === "config") return { status: 0, stdout: '"fcc-provider"\n', stderr: "" };
    return { status: 0, stdout: "hermes 0.22.5\n", stderr: "" };
  };
  const ok = probeHarness(entry, okRunner);
  assert.equal(ok.activated, true);
  assert.ok(calls.some((c) => c.includes("config get model.provider")));
  const deadRunner = (_cmd, args) => args[0] === "config"
    ? { status: 1, stdout: "", stderr: "nope" }
    : { status: 0, stdout: "hermes 0.22.5\n", stderr: "" };
  assert.equal(probeHarness(entry, deadRunner).activated, false);
  const noAct = probeHarness({ id: "x", detect: { cmd: "x" } }, () => ({ status: 0, stdout: "x 1.2.3", stderr: "" }));
  assert.equal("activated" in noAct, false);
});

test("defaultRunner handles non-existent binary without uncaught exception", () => {
  const res = defaultRunner("non_existent_binary_xyz_12345", ["--version"]);
  assert.ok(res.error || res.status !== 0);
});

test("doctor --report output shape and secret sweep", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nullform-report-test-"));
  try {
    const fakeHome = join(tmp, "home");
    const fakeRoot = join(tmp, "harness");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeRoot, { recursive: true });
    writeFileSync(join(fakeRoot, "VERSION"), "1.3.0\n", "utf8");

    // Write installation state so doctor recognizes it
    const nullformDir = join(fakeHome, ".nullform");
    mkdirSync(nullformDir, { recursive: true });
    writeFileSync(
      join(nullformDir, "installation.json"),
      JSON.stringify({
        schemaVersion: 1,
        harness: "omp",
        root: fakeRoot,
        userHome: fakeHome,
        version: "1.3.0",
      }),
      "utf8",
    );

    let stdoutData = "";
    const mockStdout = {
      write(chunk) {
        stdoutData += chunk;
      },
    };
    let stderrData = "";
    const mockStderr = {
      write(chunk) {
        stderrData += chunk;
      },
    };

    const mockRunDoctor = () => ({
      ok: true,
      mode: "installed",
      harness: fakeRoot,
      targetHarness: "omp",
      checks: [
        { id: "node", status: "pass", detail: "Node ok" },
        { id: "configs", status: "pass", detail: "Configs ok" },
      ],
      summary: { pass: 2, fail: 0, warn: 0, skip: 0 },
    });

    const mockProbeRunner = (cmd) => {
      if (cmd === "hermes") return { status: 0, stdout: "hermes 0.22.5\n", stderr: "" };
      return { status: null, error: { code: "ENOENT" }, stdout: "", stderr: "" };
    };

    const sensitiveEnv = {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      NULLFORM_USER_HOME: fakeHome,
      OPENAI_API_KEY: "sk-proj-secretKey1234567890abcdef",
      GITHUB_TOKEN: "ghp_secretGithubToken1234567890",
      PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA12345\n-----END RSA PRIVATE KEY-----",
      AUTH_TOKEN: "token_value_top_secret_xyz",
    };

    const code = await runDoctorCommand(
      {
        report: true,
        userHome: fakeHome,
        root: fakeRoot,
        harness: "omp",
      },
      {
        env: sensitiveEnv,
        stdout: mockStdout,
        stderr: mockStderr,
        runDoctor: mockRunDoctor,
        probeRunner: mockProbeRunner,
        pkgVersion: "1.3.0",
      },
    );

    assert.equal(code, 0, "runDoctorCommand should return 0 on ok doctor");

    assert.equal(stderrData, "");
    // 1. JSON parsing check
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(stdoutData);
    }, "Output should be valid JSON");

    // 2. Report shape checks
    assert.ok(parsed.report, "report key should exist on top level");
    assert.equal(parsed.report.pkgVersion, "1.3.0");
    assert.ok(parsed.report.system, "system key should exist in report");
    assert.equal(typeof parsed.report.system.platform, "string");
    assert.equal(typeof parsed.report.system.arch, "string");
    assert.equal(typeof parsed.report.system.node, "string");
    assert.equal(parsed.report.configStatus, "pass");

    assert.ok(Array.isArray(parsed.report.harnessProbes), "harnessProbes should be an array");
    assert.ok(parsed.report.harnessProbes.length > 0, "harnessProbes should contain matrix entries");

    for (const probe of parsed.report.harnessProbes) {
      assert.ok(typeof probe.id === "string", "probe id should be string");
      assert.ok(typeof probe.installed === "boolean", "probe installed should be boolean");
      assert.ok(probe.version === null || typeof probe.version === "string", "probe version should be string or null");
      assert.ok(
        ["available", "not_installed", "failed", "timeout", "unrecognized_version", "unavailable"].includes(probe.status),
        `probe status ${probe.status} should be valid status`,
      );
    }

    const hermesProbe = parsed.report.harnessProbes.find((p) => p.id === "hermes");
    assert.ok(hermesProbe, "hermes probe should be in list");
    assert.equal(hermesProbe.installed, true);
    assert.equal(hermesProbe.version, "0.22.5");
    assert.equal(hermesProbe.status, "available");

    // 3. Secret sweep (negative checks)
    assert.doesNotMatch(stdoutData, /sk-[a-zA-Z0-9_-]{10,}/, "Report must not contain sk- keys");
    assert.doesNotMatch(stdoutData, /ghp_[a-zA-Z0-9]{10,}/, "Report must not contain ghp_ tokens");
    assert.doesNotMatch(stdoutData, /PRIVATE KEY/, "Report must not contain private keys");
    assert.doesNotMatch(stdoutData, /secretKey1234567890abcdef/, "Report must not contain secret key value");
    assert.doesNotMatch(stdoutData, /secretGithubToken1234567890/, "Report must not contain github token value");
    assert.doesNotMatch(stdoutData, /token_value_top_secret_xyz/, "Report must not contain auth token value");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
