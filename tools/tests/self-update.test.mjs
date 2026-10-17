import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  PACKAGE_NAME,
  parseSemVer,
  compareSemVer,
  validateInstallationState,
  readInstallationState,
  writeInstallationState,
  resolveRegistryConfig,
  extractNpmMetadata,
  detectEffectivePrefix,
  checkRelease,
  executeUpdate,
  sanitizeError,
  validateHttpUrl,
} from "../self-update.mjs";
import { runDoctor } from "../doctor.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SELF_UPDATE_PATH = join(REPO_ROOT, "tools", "self-update.mjs");
const DOCTOR_PATH = join(REPO_ROOT, "tools", "doctor.mjs");

function createMockServer(responseHandler) {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => responseHandler(req, res));
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolvePromise({
        server,
        port,
        baseUrl,
        url: `${baseUrl}/${PACKAGE_NAME}/latest`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function runCliAsync(scriptPath, args, env = process.env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
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
  assert.equal(compareSemVer("2.0.0", "1.9.9"), 1);
  assert.equal(compareSemVer("1.0.0-alpha", "1.0.0"), -1);
});

test("installation state validation and persistence fail closed on bad data", () => {
  const tmp = createTempDir("state-test-");
  try {
    assert.equal(readInstallationState(tmp), null);

    const rootDir = join(tmp, "custom-root");
    const managedFile = join(tmp, ".opencode", "opencode.json");
    const { statePath, state } = writeInstallationState(tmp, {
      schemaVersion: 1,
      harness: "opencode",
      root: rootDir,
      userHome: tmp,
      version: "1.1.0",
      managedFiles: { [managedFile]: "sha256-abc" },
    });
    assert.equal(existsSync(statePath), true);
    assert.equal(state.harness, "opencode");
    assert.deepEqual(readInstallationState(tmp), state);

    const validWithProject = validateInstallationState({
      ...state,
      projectRoot: join(tmp, "project-root"),
    });
    assert.equal(validWithProject.projectRoot, join(tmp, "project-root"));
    assert.throws(() => validateInstallationState({ ...state, projectRoot: "relative/path" }), /absolute path/);
    assert.throws(() => validateInstallationState({ ...state, projectRoot: "-bad-start" }), /absolute path/);
    assert.throws(() => validateInstallationState({ ...state, schemaVersion: 2 }), /schemaVersion/);
    assert.throws(() => validateInstallationState({ ...state, harness: "auto" }), /Invalid harness/);
    assert.throws(() => validateInstallationState({ ...state, root: "relative/path" }), /absolute path/);
    assert.throws(() => validateInstallationState({ ...state, apiKey: "secret" }), /unexpected field/);

    writeFileSync(statePath, "{corrupt json", "utf8");
    assert.throws(() => readInstallationState(tmp), /Corrupted installation state JSON/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractNpmMetadata reads npm version and dist-tags, rejecting GitHub tag_name", () => {
  assert.deepEqual(extractNpmMetadata({ name: PACKAGE_NAME, version: "1.2.0" }), {
    version: "1.2.0",
    tarballUrl: null,
  });
  assert.deepEqual(
    extractNpmMetadata({
      name: PACKAGE_NAME,
      "dist-tags": { latest: "1.3.0" },
      versions: { "1.3.0": { dist: { tarball: "http://127.0.0.1/pkg.tgz" } } },
    }),
    { version: "1.3.0", tarballUrl: "http://127.0.0.1/pkg.tgz" }
  );
  assert.equal(extractNpmMetadata({ tag_name: "v1.2.0", name: "Release 1.2.0" }), null);
});

test("checkRelease: behind -> drift from npm metadata and packument", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.1.0\n", "utf8");

  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === `/${PACKAGE_NAME}`) {
      res.end(
        JSON.stringify({
          name: PACKAGE_NAME,
          "dist-tags": { latest: "1.2.0" },
          versions: { "1.2.0": { version: "1.2.0" } },
        })
      );
      return;
    }
    res.end(JSON.stringify({ name: PACKAGE_NAME, version: "1.2.0" }));
  });

  try {
    const res = await checkRelease({ root: tmp, registry: mock.baseUrl });
    assert.equal(res.status, "drift");
    assert.equal(res.ok, true);
    assert.equal(res.drift, true);
    assert.equal(res.current, "1.1.0");
    assert.equal(res.latest, "1.2.0");
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkRelease: equal -> clean and GitHub-only payload -> setup", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.1.0\n", "utf8");

  let mode = "npm";
  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (mode === "github") {
      res.end(JSON.stringify({ tag_name: "v1.9.0" }));
    } else {
      res.end(JSON.stringify({ name: PACKAGE_NAME, version: "1.1.0" }));
    }
  });

  try {
    const cleanRes = await checkRelease({ root: tmp, apiUrl: mock.url });
    assert.equal(cleanRes.status, "clean");
    assert.equal(cleanRes.drift, false);
    assert.equal(cleanRes.current, "1.1.0");
    assert.equal(cleanRes.latest, "1.1.0");

    mode = "github";
    const ghRes = await checkRelease({ root: tmp, apiUrl: mock.url });
    assert.equal(ghRes.status, "setup");
    assert.equal(ghRes.latest, null);
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkRelease: offline, 404, missing VERSION and .npmrc registry", async () => {
  const tmp = createTempDir();
  try {
    const missingVer = await checkRelease({ root: tmp });
    assert.equal(missingVer.status, "setup");
    assert.equal(missingVer.missingVersion, true);

    writeFileSync(join(tmp, "VERSION"), "1.1.0\n", "utf8");
    const offline = await checkRelease({
      root: tmp,
      apiUrl: "http://127.0.0.1:59999/nullform-workflow/latest",
      timeoutMs: 300,
    });
    assert.equal(offline.status, "setup");
    assert.equal(offline.offline, true);

    const mock404 = await createMockServer((req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });
    try {
      writeFileSync(join(tmp, ".npmrc"), `registry=${mock404.baseUrl}\n`, "utf8");
      const cfg = resolveRegistryConfig({ userHome: tmp, env: {} });
      assert.equal(cfg.registryUrl, mock404.baseUrl);

      const notFound = await checkRelease({ root: tmp, userHome: tmp, env: {} });
      assert.equal(notFound.status, "setup");
      assert.equal(notFound.notPublished, true);
      assert.match(notFound.detail, /No releases found/i);
    } finally {
      await mock404.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectEffectivePrefix resolves Windows and POSIX global node_modules layouts", () => {
  const winPkg = resolve("/tmp/win-prefix/node_modules/nullform-workflow");
  assert.equal(detectEffectivePrefix({ packageRoot: winPkg, env: {} }), resolve("/tmp/win-prefix"));

  const posixPkg = resolve("/tmp/posix-prefix/lib/node_modules/nullform-workflow");
  assert.equal(detectEffectivePrefix({ packageRoot: posixPkg, env: {} }), resolve("/tmp/posix-prefix"));

  const explicit = resolve("/tmp/explicit-prefix");
  assert.equal(detectEffectivePrefix({ prefix: explicit, packageRoot: winPkg, env: {} }), explicit);
});

test("executeUpdate: fails closed on missing or invalid installation state", async () => {
  const tmpHome = createTempDir("update-nostate-");
  try {
    const missing = await executeUpdate({ userHome: tmpHome });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "missing_state");

    const stateDir = join(tmpHome, ".nullform");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "installation.json"), "{bad", "utf8");

    const corrupt = await executeUpdate({ userHome: tmpHome });
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.error, "invalid_state");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("executeUpdate: --dry-run plans npm global install + nullform init without Git", async () => {
  const tmp = createTempDir("update-dry-");
  const rootDir = join(tmp, "Root With Spaces");
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(join(rootDir, "VERSION"), "1.1.0\n", "utf8");
  writeInstallationState(tmp, {
    schemaVersion: 1,
    harness: "opencode",
    root: rootDir,
    userHome: tmp,
    version: "1.1.0",
  });

  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: PACKAGE_NAME, "dist-tags": { latest: "1.2.0" }, versions: { "1.2.0": { name: PACKAGE_NAME, version: "1.2.0" } } }));
  });

  let spawned = false;
  try {
    const res = await executeUpdate({
      userHome: tmp,
      registry: mock.baseUrl,
      prefix: join(tmp, "Prefix With Spaces"),
      dryRun: true,
      spawnFn: () => {
        spawned = true;
        return { status: 0 };
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(spawned, false);
    assert.equal(res.current, "1.1.0");
    assert.equal(res.latest, "1.2.0");
    assert.ok(res.plan.some((p) => p.includes("npm install --global --ignore-scripts")));
    assert.ok(res.plan.some((p) => p.includes("nullform init --harness opencode")));
    assert.equal(res.plan.some((p) => p.includes("git ")), false);
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("executeUpdate: retry when VERSION advanced but state is behind and real npm 404 tarball boundary", async () => {
  const tmp = createTempDir("update-retry-");
  const homeDir = join(tmp, "Home With Spaces");
  const rootDir = join(tmp, "Workflow Root");
  const projectDir = join(tmp, "Cursor Project");
  const prefixDir = join(tmp, "Global Prefix");
  const cacheDir = join(tmp, "npm-cache");

  mkdirSync(rootDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(prefixDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(rootDir, "VERSION"), "1.2.0\n", "utf8");
  writeInstallationState(homeDir, {
    schemaVersion: 1,
    harness: "cursor",
    root: rootDir,
    projectRoot: projectDir,
    userHome: homeDir,
    version: "1.1.0",
  });

  const mock = await createMockServer((req, res) => {
    if (req.url?.endsWith(".tgz")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "tarball missing" }));
      return;
    }
    const tarballUrl = `http://127.0.0.1:${mock.port}/${PACKAGE_NAME}/-/${PACKAGE_NAME}-1.2.0.tgz`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        name: PACKAGE_NAME,
        "dist-tags": { latest: "1.2.0" },
        versions: {
          "1.2.0": {
            name: PACKAGE_NAME,
            version: "1.2.0",
            dist: { tarball: tarballUrl },
          },
        },
      })
    );
  });

  try {
    const dryRes = await executeUpdate({
      userHome: homeDir,
      prefix: prefixDir,
      registry: mock.baseUrl,
      dryRun: true,
    });
    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.updated, false);
    assert.equal(dryRes.current, "1.1.0", "Must use verified savedState.version 1.1.0 rather than unverified VERSION 1.2.0");
    assert.equal(dryRes.latest, "1.2.0");
    assert.equal(dryRes.projectRoot, projectDir);
    assert.ok(dryRes.plan.some((p) => p.includes("--project-root")));

    const failCli = await runCliAsync(
      SELF_UPDATE_PATH,
      ["update", "--user-home", homeDir, "--prefix", prefixDir, "--registry", mock.baseUrl, "--yes", "--json"],
      {
        ...process.env,
        npm_config_fetch_retries: "0",
        NPM_CONFIG_FETCH_RETRIES: "0",
        npm_config_cache: cacheDir,
        NPM_CONFIG_CACHE: cacheDir,
      }
    );
    assert.equal(failCli.status, 1);
    const failJson = JSON.parse(failCli.stdout);
    assert.equal(failJson.ok, false);
    assert.equal(failJson.updated, false);
    assert.equal(failJson.error, "npm_install_failed");
    assert.equal(readInstallationState(homeDir).version, "1.1.0", "Failed update must not advance savedState.version");

    writeInstallationState(homeDir, {
      schemaVersion: 1,
      harness: "cursor",
      root: rootDir,
      projectRoot: projectDir,
      userHome: homeDir,
      version: "1.2.0",
    });
    const upToDate = await executeUpdate({
      userHome: homeDir,
      prefix: prefixDir,
      registry: mock.baseUrl,
    });
    assert.equal(upToDate.ok, true);
    assert.equal(upToDate.updated, false);
    assert.equal(upToDate.current, "1.2.0");
    assert.equal(upToDate.latest, "1.2.0");
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: self-update check and doctor release-drift against mock npm registry", async () => {
  const tmp = createTempDir();
  writeFileSync(join(tmp, "VERSION"), "1.0.0\n", "utf8");

  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: PACKAGE_NAME, version: "1.2.0" }));
  });

  try {
    const checkCli = await runCliAsync(SELF_UPDATE_PATH, [
      "check",
      "--root",
      tmp,
      "--api-url",
      mock.url,
      "--json",
    ]);
    assert.equal(checkCli.status, 0);
    const checkJson = JSON.parse(checkCli.stdout);
    assert.equal(checkJson.status, "drift");
    assert.equal(checkJson.current, "1.0.0");
    assert.equal(checkJson.latest, "1.2.0");

    const docDirect = runDoctor({
      harness: tmp,
      agentDir: join(tmp, "agent-dir"),
      agentsHome: join(tmp, "agents-home"),
      releaseInfo: checkJson,
    });
    const driftCheck = docDirect.checks.find((c) => c.id === "release-drift");
    assert.ok(driftCheck);
    assert.equal(driftCheck.status, "warn");

    const docCli = await runCliAsync(DOCTOR_PATH, [
      "--harness",
      tmp,
      "--release-url",
      mock.url,
      "--json",
    ]);
    const docJson = JSON.parse(docCli.stdout);
    const cliDriftCheck = docJson.checks.find((c) => c.id === "release-drift");
    assert.ok(cliDriftCheck);
    assert.equal(cliDriftCheck.status, "warn");
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sanitizeError redacts tokens, passwords, and URL credentials while keeping safe labels", () => {
  const canary1 = "SYNTHETIC_CANARY_AUTH_TOKEN_99182";
  const canary2 = "SYNTHETIC_CANARY_USER_SECRET_77213";
  const canary3 = "SYNTHETIC_CANARY_BEARER_88341";
  const canary4 = "SYNTHETIC_CANARY_URL_CRED_11452";

  const tokenInput = `npm ERR! 401 Unauthorized: //registry.npmjs.org/:_authToken=${canary1}`;
  const sanitizedToken = sanitizeError(tokenInput);
  assert.ok(!sanitizedToken.includes(canary1), "Synthetic token canary must be redacted");
  ;

  const passInput = `database connection failed: password=${canary2}`;
  const sanitizedPass = sanitizeError(passInput);
  assert.ok(!sanitizedPass.includes(canary2), "Synthetic password canary must be redacted");
  ;

  const bearerInput = `Authorization header invalid: Bearer ${canary3}`;
  const sanitizedBearer = sanitizeError(bearerInput);
  assert.ok(!sanitizedBearer.includes(canary3), "Synthetic bearer canary must be redacted");
  ;

  const urlInput = `Failed to fetch from https://testuser:${canary4}@registry.example.org/pkg`;
  const sanitizedUrl = sanitizeError(urlInput);
  assert.ok(!sanitizedUrl.includes(canary4), "Synthetic URL credential canary must be redacted");
  ;
});

test("validateHttpUrl redacts credentials in exception messages on invalid URLs", () => {
  const canaryPass = "CANARY_SYNTHETIC_NOT_A_SECRET";
  const badUrl = `https://audituser:${canaryPass}@registry.invalid/a b`;
  assert.throws(
    () => validateHttpUrl(badUrl, "registry"),
    (err) => {
      assert.ok(!err.message.includes(canaryPass), "Password must be redacted in exception message");
      ;
      ;
      return true;
    }
  );

  const notUrl = `https://testuser:${canaryPass}@@bad-url:::`;
  assert.throws(
    () => validateHttpUrl(notUrl, "registry"),
    (err) => {
      assert.ok(!err.message.includes(canaryPass), "Password must be redacted in exception message");
      ;
      return true;
    }
  );
});

test("checkRelease and executeUpdate honor home .npmrc _authToken with loopback auth server", async () => {
  const syntheticToken = "SYNTHETIC_AUTH_TOKEN_TEST_SCOPE_8892";
  let receivedAuth = null;

  const mock = await createMockServer((req, res) => {
    receivedAuth = req.headers.authorization;
    if (receivedAuth !== `Bearer ${syntheticToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.url === `/${PACKAGE_NAME}` || req.url === `/${PACKAGE_NAME}/latest`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: PACKAGE_NAME,
          "dist-tags": { latest: "1.2.0" },
          versions: {
            "1.2.0": {
              name: PACKAGE_NAME,
              version: "1.2.0",
              dist: { tarball: `http://127.0.0.1:${mock.port}/tarball.tgz` },
            },
          },
        })
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  const tmp = createTempDir("auth-server-test-");
  const tmpRoot = join(tmp, "workflow-root");
  const tmpHome = join(tmp, "user-home");
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(tmpHome, { recursive: true });
  writeFileSync(join(tmpRoot, "VERSION"), "1.1.0\n", "utf8");

  try {
    // 1. Without token in .npmrc: fails with 401
    const unauthRes = await checkRelease({ root: tmpRoot, userHome: tmpHome, registry: mock.baseUrl });
    assert.equal(unauthRes.status, "setup");
    assert.equal(unauthRes.latest, null);

    // 2. With token in .npmrc: succeeds with drift 1.1.0 -> 1.2.0
    const npmrcContent = `registry=${mock.baseUrl}/\n//127.0.0.1:${mock.port}/:_authToken=${syntheticToken}\n`;
    writeFileSync(join(tmpHome, ".npmrc"), npmrcContent, "utf8");

    const authRes = await checkRelease({ root: tmpRoot, userHome: tmpHome });
    assert.equal(authRes.status, "drift");
    assert.equal(authRes.ok, true);
    assert.equal(authRes.current, "1.1.0");
    assert.equal(authRes.latest, "1.2.0");
    assert.equal(receivedAuth, `Bearer ${syntheticToken}`);

    // 3. executeUpdate in dryRun succeeds without aborting with 401
    writeInstallationState(tmpHome, {
      schemaVersion: 1,
      harness: "claude",
      root: tmpRoot,
      userHome: tmpHome,
      version: "1.1.0",
    });

    const updateDry = await executeUpdate({
      userHome: tmpHome,
      dryRun: true,
    });
    assert.equal(updateDry.ok, true);
    assert.equal(updateDry.latest, "1.2.0");
    assert.equal(updateDry.current, "1.1.0");
  } finally {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
