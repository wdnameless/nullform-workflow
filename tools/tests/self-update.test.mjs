import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseSemVer,
  compareSemVer,
  checkRelease,
  executeUpdate,
  checkWorkingTreeClean,
} from "../self-update.mjs";
import { runDoctor } from "../doctor.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SELF_UPDATE_PATH = join(REPO_ROOT, "tools", "self-update.mjs");
const DOCTOR_PATH = join(REPO_ROOT, "tools", "doctor.mjs");

function createMockServer(responseHandler) {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      responseHandler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/releases/latest`;
      resolvePromise({
        server,
        url,
        port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
function runCliAsync(scriptPath, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      resolvePromise({ status, stdout, stderr });
    });
  });
}


function createTempDir(prefix = "selfupdate-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("SemVer parsing and comparison", () => {
  assert.equal(parseSemVer(""), null);
  assert.equal(parseSemVer("invalid"), null);

  const v1 = parseSemVer("1.0.0");
  assert.deepEqual(v1, { major: 1, minor: 0, patch: 0, prerelease: null, raw: "1.0.0" });

  const v2 = parseSemVer("v1.2.3-rc.1");
  assert.deepEqual(v2, { major: 1, minor: 2, patch: 3, prerelease: "rc.1", raw: "1.2.3-rc.1" });

  assert.equal(compareSemVer("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemVer("v1.0.0", "1.0.0"), 0);
  assert.equal(compareSemVer("1.0.0", "1.0.1"), -1);
  assert.equal(compareSemVer("1.0.0", "1.1.0"), -1);
  assert.equal(compareSemVer("1.9.9", "2.0.0"), -1);
  assert.equal(compareSemVer("2.0.0", "1.9.9"), 1);
  assert.equal(compareSemVer("1.0.0-alpha", "1.0.0"), -1);
  assert.equal(compareSemVer("1.0.0", "1.0.0-alpha"), 1);
});

test("checkRelease: behind -> drift", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      tag_name: "v1.1.0",
      name: "Release 1.1.0",
      html_url: "https://github.com/wdnameless/nullform-workflow/releases/tag/v1.1.0",
    }));
  });

  try {
    const res = await checkRelease({ root: tmp, apiUrl: mock.url });
    assert.equal(res.status, "drift");
    assert.equal(res.ok, true);
    assert.equal(res.drift, true);
    assert.equal(res.current, "1.0.0");
    assert.equal(res.latest, "1.1.0");
    assert.equal(res.tag, "v1.1.0");
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkRelease: equal -> clean", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      tag_name: "v1.0.0",
      name: "Release 1.0.0",
      html_url: "https://github.com/wdnameless/nullform-workflow/releases/tag/v1.0.0",
    }));
  });

  try {
    const res = await checkRelease({ root: tmp, apiUrl: mock.url });
    assert.equal(res.status, "clean");
    assert.equal(res.ok, true);
    assert.equal(res.drift, false);
    assert.equal(res.current, "1.0.0");
    assert.equal(res.latest, "1.0.0");
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkRelease: offline -> graceful (SETUP not FAIL)", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  // Pick an unreachable local port to simulate offline
  const unreachableUrl = "http://127.0.0.1:59999/releases/latest";

  try {
    const res = await checkRelease({ root: tmp, apiUrl: unreachableUrl, timeoutMs: 500 });
    assert.equal(res.status, "setup");
    assert.equal(res.ok, true);
    assert.equal(res.offline, true);
    assert.equal(res.current, "1.0.0");
    assert.equal(res.latest, null);
    assert.match(res.detail, /unreachable/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkRelease: 404 no releases -> graceful SETUP", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  const mock = await createMockServer((req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  });

  try {
    const res = await checkRelease({ root: tmp, apiUrl: mock.url });
    assert.equal(res.status, "setup");
    assert.equal(res.ok, true);
    assert.match(res.detail, /No releases found/i);
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkRelease: missing VERSION -> graceful SETUP", async () => {
  const tmp = createTempDir();
  try {
    const res = await checkRelease({ root: tmp });
    assert.equal(res.status, "setup");
    assert.equal(res.ok, true);
    assert.equal(res.missingVersion, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("executeUpdate: update --dry-run returns plan without writing", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v1.1.0", name: "v1.1.0" }));
  });

  // Mock git commands for clean repo check
  const mockSpawn = (cmd, args) => {
    if (args.includes("--is-inside-work-tree")) return { status: 0, stdout: "true" };
    if (args.includes("--porcelain")) return { status: 0, stdout: "" };
    return { status: 0, stdout: "" };
  };

  try {
    const res = await executeUpdate({
      root: tmp,
      apiUrl: mock.url,
      dryRun: true,
      spawnFn: mockSpawn,
    });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.current, "1.0.0");
    assert.equal(res.targetTag, "v1.1.0");
    assert.ok(Array.isArray(res.plan));
    assert.ok(res.plan.some((p) => p.includes("git merge --ff-only v1.1.0")));
    assert.ok(res.plan.some((p) => p.includes("install-harness.mjs --dry-run")));
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("executeUpdate: refuses on dirty working tree with instructions", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  const mockSpawn = (cmd, args) => {
    if (args.includes("--is-inside-work-tree")) return { status: 0, stdout: "true" };
    if (args.includes("--porcelain")) {
      return { status: 0, stdout: " M tools/doctor.mjs\n?? untracked.txt\n" };
    }
    return { status: 0, stdout: "" };
  };

  try {
    const res = await executeUpdate({
      root: tmp,
      spawnFn: mockSpawn,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "dirty_tree");
    assert.ok(res.instructions.length > 0);
    assert.ok(res.instructions.some((i) => i.includes("git stash")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("executeUpdate: refuses on non-fast-forward with manual instructions", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v1.1.0" }));
  });

  const mockSpawn = (cmd, args) => {
    if (args.includes("--is-inside-work-tree")) return { status: 0, stdout: "true" };
    if (args.includes("--porcelain")) return { status: 0, stdout: "" };
    if (args.includes("fetch")) return { status: 0, stdout: "" };
    if (args.includes("--is-ancestor")) return { status: 1, stderr: "not ancestor" };
    return { status: 0, stdout: "" };
  };

  try {
    const res = await executeUpdate({
      root: tmp,
      apiUrl: mock.url,
      spawnFn: mockSpawn,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "non_fast_forward");
    assert.ok(res.instructions.some((i) => i.includes("resolve conflicts manually")));
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("doctor: release-drift check emits WARN when behind (never FAIL)", () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  try {
    const result = runDoctor({
      harness: tmp,
      agentDir: join(tmp, "agent-dir"),
      agentsHome: join(tmp, "agents-home"),
      releaseInfo: { status: "drift", current: "1.0.0", latest: "1.1.0" },
    });

    const check = result.checks.find((c) => c.id === "release-drift");
    assert.ok(check, "release-drift check should exist");
    assert.equal(check.status, "warn");
    assert.match(check.detail, /отстает от релиза v1.1.0/);
    assert.notEqual(check.status, "fail", "release-drift must never be fail");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("doctor: release-drift check emits SKIP when missing VERSION or offline", () => {
  const tmp = createTempDir();
  try {
    // 1. Missing VERSION
    const noVersion = runDoctor({
      harness: tmp,
      agentDir: join(tmp, "agent-dir"),
      agentsHome: join(tmp, "agents-home"),
    });
    const check1 = noVersion.checks.find((c) => c.id === "release-drift");
    assert.ok(check1);
    assert.equal(check1.status, "skip");
    assert.match(check1.detail, /VERSION не найден/);

    // 2. VERSION present, but offline
    writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");
    const offlineDoc = runDoctor({
      harness: tmp,
      agentDir: join(tmp, "agent-dir"),
      agentsHome: join(tmp, "agents-home"),
      releaseInfo: { offline: true, error: "ENOTFOUND" },
    });
    const check2 = offlineDoc.checks.find((c) => c.id === "release-drift");
    assert.ok(check2);
    assert.equal(check2.status, "skip");
    assert.match(check2.detail, /офлайн/);

    // 3. Clean
    const cleanDoc = runDoctor({
      harness: tmp,
      agentDir: join(tmp, "agent-dir"),
      agentsHome: join(tmp, "agents-home"),
      releaseInfo: { status: "clean", latest: "1.0.0" },
    });
    const check3 = cleanDoc.checks.find((c) => c.id === "release-drift");
    assert.ok(check3);
    assert.equal(check3.status, "pass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: self-update check --json against mock server", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v1.2.0" }));
  });

  try {
    const res = await runCliAsync(SELF_UPDATE_PATH, [
      "check", "--root", tmp, "--api-url", mock.url, "--json",
    ]);
    const json = JSON.parse(res.stdout);
    assert.equal(json.status, "drift");
    assert.equal(json.current, "1.0.0");
    assert.equal(json.latest, "1.2.0");
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: self-update update --dry-run --json against mock server", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  // Init a real temporary git repo for CLI test
  spawnSync("git", ["init", tmp], { encoding: "utf8" });
  spawnSync("git", ["-C", tmp, "config", "user.name", "Test"], { encoding: "utf8" });
  spawnSync("git", ["-C", tmp, "config", "user.email", "test@test.com"], { encoding: "utf8" });
  spawnSync("git", ["-C", tmp, "add", "VERSION"], { encoding: "utf8" });
  spawnSync("git", ["-C", tmp, "commit", "-m", "init"], { encoding: "utf8" });

  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v1.0.5" }));
  });

  try {
    const res = await runCliAsync(SELF_UPDATE_PATH, [
      "update", "--dry-run", "--root", tmp, "--api-url", mock.url, "--json",
    ]);
    assert.equal(res.status, 0);
    const json = JSON.parse(res.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.dryRun, true);
    assert.equal(json.targetTag, "v1.0.5");
    assert.ok(json.plan.length > 0);
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: doctor emits WARN on release drift against mock server", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v1.2.0" }));
  });

  try {
    const res = await runCliAsync(DOCTOR_PATH, [
      "--harness", tmp, "--release-url", mock.url, "--json",
    ]);
    const json = JSON.parse(res.stdout);
    const check = json.checks.find((c) => c.id === "release-drift");
    assert.ok(check);
    assert.equal(check.status, "warn");
    assert.match(check.detail, /отстает от релиза/);
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
