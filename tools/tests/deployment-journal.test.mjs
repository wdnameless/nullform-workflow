/**
 * Real filesystem faults and parent-killed transaction regressions for identity publication,
 * durable commit decisions, cleanup, and preservation of human edits.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireDeploymentLock, recoverAbandonedJournal, getDeploymentJournalPath } from "../deployment-journal.mjs";
import { readInstallationState, writeInstallationState, getStateFilePath } from "../installation-state.mjs";
import { hashContent } from "../harness-config.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const transactionChild = String.raw`
  import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  import { join, resolve } from 'node:path';
  const options = JSON.parse(process.argv[1]);
  const { userHome, targetRoot, boundary, mode, standalone } = options;
  const native = { ...fs };
  const statePath = join(userHome, '.nullform', 'installation.json');
  const journalPath = join(userHome, '.nullform', 'deployment-journal.json');
  const fds = new Map();
  let armed = false;
  function stop() {
    armed = false;
    if (mode === 'fault') throw Object.assign(new Error('filesystem operation failed'), { code: boundary.endsWith('rename') ? 'EACCES' : 'EIO' });
    native.writeSync(1, 'BOUNDARY\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  fs.openSync = (path, ...args) => {
    const fd = native.openSync(path, ...args);
    fds.set(fd, String(path));
    return fd;
  };
  fs.closeSync = (fd) => { fds.delete(fd); return native.closeSync(fd); };
  fs.writeSync = (fd, content, ...args) => {
    if (armed && boundary === 'identity-write' && /[.]installation[.]/.test(fds.get(fd) || '')) stop();
    if (armed && boundary === 'marker-write' && String(content).includes('"status": "committed"')) stop();
    return native.writeSync(fd, content, ...args);
  };
  fs.renameSync = (src, dest) => {
    const identity = resolve(String(dest)) === resolve(statePath);
    if (armed && identity && boundary === 'before-identity') stop();
    if (armed && identity && boundary === 'identity-rename') stop();
    if (armed && boundary === 'marker-rename' && resolve(String(dest)) === resolve(journalPath) &&
        native.readFileSync(src, 'utf8').includes('"status": "committed"')) stop();
    const result = native.renameSync(src, dest);
    if (armed && identity && boundary === 'after-identity') stop();
    return result;
  };
  fs.rmSync = (path, ...args) => {
    if (armed && ['before-backup-cleanup', 'backup-cleanup'].includes(boundary) &&
        resolve(String(path)).startsWith(resolve(join(userHome, '.nullform', 'backups')))) {
      if (boundary === 'backup-cleanup') {
        const first = native.readdirSync(path)[0];
        if (first) native.unlinkSync(join(path, first));
      }
      stop();
    }
    return native.rmSync(path, ...args);
  };
  fs.unlinkSync = (path, ...args) => {
    if (armed && boundary === 'journal-cleanup' && resolve(String(path)) === resolve(journalPath)) stop();
    return native.unlinkSync(path, ...args);
  };
  syncBuiltinESMExports();
  const { DeploymentJournal, acquireDeploymentLock, safeAtomicWrite } = await import(options.journalModule);
  const { readInstallationState } = await import(options.stateModule);
  const { hashContent } = await import(options.configModule);
  const prior = readInstallationState(userHome) || options.prior;
  acquireDeploymentLock({ userHome, targetRoot, harness: 'opencode' });
  const journal = new DeploymentJournal({ userHome, targetRoot, harness: 'opencode', targetVersion: '1.2.0' });
  journal.start();
  const owned = join(targetRoot, 'owned.txt');
  journal.recordBeforeWrite(owned, 'NEW');
  safeAtomicWrite(owned, 'NEW');
  journal.recordWritten(owned);
  armed = true;
  try {
    if (standalone) journal.finalize();
    else journal.commit({ ...prior, version: '1.2.0', managedFiles: { [owned]: hashContent('NEW') } });
  } catch (err) {
    if (mode !== 'fault' || !['EIO', 'EACCES'].includes(err.code)) throw err;
    native.writeSync(1, err.code + '\n');
  }
`;

function transactionFixture({ identity = true } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "transaction-sandbox-"));
  const userHome = join(sandbox, "home");
  const targetRoot = join(sandbox, "target");
  mkdirSync(userHome);
  mkdirSync(targetRoot);
  const owned = join(targetRoot, "owned.txt");
  const human = join(targetRoot, "human-notes.md");
  writeFileSync(owned, "OLD");
  writeFileSync(human, "# Human original notes");
  const prior = {
    schemaVersion: 1, harness: "opencode", root: targetRoot, userHome, version: "1.0.0", managedFiles: {},
  };
  if (identity) writeInstallationState(userHome, prior);
  const identityBytes = identity ? readFileSync(getStateFilePath(userHome)) : null;
  return { sandbox, userHome, targetRoot, owned, human, prior, identityBytes };
}

function transactionArgs(fixture, options) {
  return ["--input-type=module", "-e", transactionChild, JSON.stringify({
    userHome: fixture.userHome, targetRoot: fixture.targetRoot, prior: fixture.prior, ...options,
    journalModule: new URL("../deployment-journal.mjs", import.meta.url).href,
    stateModule: new URL("../installation-state.mjs", import.meta.url).href,
    configModule: new URL("../harness-config.mjs", import.meta.url).href,
  })];
}

async function killAtBoundary(fixture, options) {
  const child = spawn(process.execPath, transactionArgs(fixture, { mode: "kill", ...options }), {
    cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit) => child.once("close", (code, signal) => resolveExit({ code, signal })));
  let timer;
  try {
    await new Promise((resolveReady, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("BOUNDARY\n")) resolveReady();
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error("Child missed boundary: " + code + " " + stderr)));
      timer = setTimeout(() => reject(new Error("Child boundary timed out: " + stderr)), 15000);
    });
    assert.equal(child.kill("SIGKILL"), true, "Parent must actually kill the blocked child");
    const death = await exited;
    assert.notEqual(death.code, 0, "Killed child must not complete normally");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}

for (const boundary of ["identity-write", "identity-rename", "marker-write", "marker-rename"]) {
  test("1. fault: filesystem failure at " + boundary + " rolls back target and identity after partial work", () => {
    const fixture = transactionFixture();
    try {
      const result = spawnSync(process.execPath, transactionArgs(fixture, { mode: "fault", boundary }), {
        cwd: REPO_ROOT, encoding: "utf8", timeout: 20000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, boundary.endsWith("rename") ? "EACCES\n" : "EIO\n", "A filesystem operation must actually fail");
      assert.deepEqual(readFileSync(getStateFilePath(fixture.userHome)), fixture.identityBytes);
      assert.equal(readFileSync(fixture.owned, "utf8"), "OLD");
      assert.equal(readFileSync(fixture.human, "utf8"), "# Human original notes");
      assert.equal(existsSync(getDeploymentJournalPath(fixture.userHome)), false);
    } finally {
      rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  });
}

for (const boundary of ["before-identity", "after-identity", "before-backup-cleanup", "backup-cleanup", "journal-cleanup"]) {
  test("2. kill: parent SIGKILL at " + boundary + " recovers coherent target and identity", async () => {
    const fixture = transactionFixture();
    try {
      await killAtBoundary(fixture, { boundary });
      const committed = ["before-backup-cleanup", "backup-cleanup", "journal-cleanup"].includes(boundary);
      const lock = acquireDeploymentLock({ userHome: fixture.userHome, targetRoot: fixture.targetRoot, harness: "opencode" });
      lock.release();
      const state = readInstallationState(fixture.userHome);
      if (committed) {
        assert.equal(state.version, "1.2.0");
        assert.equal(state.root, fixture.prior.root);
        assert.deepEqual(state.managedFiles, { [fixture.owned]: hashContent(readFileSync(fixture.owned)) });
      } else {
        assert.deepEqual(state, fixture.prior);
        assert.deepEqual(readFileSync(getStateFilePath(fixture.userHome)), fixture.identityBytes);
      }
      assert.equal(readFileSync(fixture.owned, "utf8"), committed ? "NEW" : "OLD");
      assert.equal(readFileSync(fixture.human, "utf8"), "# Human original notes");
      assert.equal(existsSync(getDeploymentJournalPath(fixture.userHome)), false);
    } finally {
      rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  });
}

for (const boundary of ["backup-cleanup", "journal-cleanup"]) {
  test("2. standalone finalize: parent SIGKILL during " + boundary + " preserves committed files", async () => {
    const fixture = transactionFixture();
    try {
      await killAtBoundary(fixture, { boundary, standalone: true });
      const recovery = recoverAbandonedJournal(fixture.userHome, { targetRoot: fixture.targetRoot });
      assert.equal(recovery.status, "committed");
      assert.equal(readFileSync(fixture.owned, "utf8"), "NEW");
      assert.deepEqual(readFileSync(getStateFilePath(fixture.userHome)), fixture.identityBytes);
      assert.equal(readFileSync(fixture.human, "utf8"), "# Human original notes");
      assert.equal(existsSync(getDeploymentJournalPath(fixture.userHome)), false);
    } finally {
      rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  });
}

test("2. kill conflict: human replacement after identity write is preserved with ECONFLICT", async () => {
  const fixture = transactionFixture();
  try {
    await killAtBoundary(fixture, { boundary: "after-identity" });
    writeFileSync(fixture.owned, "HUMAN REPLACEMENT");
    assert.throws(() => recoverAbandonedJournal(fixture.userHome, { targetRoot: fixture.targetRoot }), { code: "ECONFLICT" });
    assert.equal(readFileSync(fixture.owned, "utf8"), "HUMAN REPLACEMENT");
    assert.deepEqual(readFileSync(getStateFilePath(fixture.userHome)), fixture.identityBytes);
    assert.equal(readFileSync(fixture.human, "utf8"), "# Human original notes");
    assert.equal(existsSync(getDeploymentJournalPath(fixture.userHome)), true);
  } finally {
    rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});

test("2. kill first identity: recovery removes a newly published identity and restores prior target bytes", async () => {
  const fixture = transactionFixture({ identity: false });
  try {
    await killAtBoundary(fixture, { boundary: "after-identity" });
    const recovery = recoverAbandonedJournal(fixture.userHome, { targetRoot: fixture.targetRoot });
    assert.equal(recovery.status, "restored");
    assert.equal(readInstallationState(fixture.userHome), null);
    assert.equal(readFileSync(fixture.owned, "utf8"), "OLD");
    assert.equal(readFileSync(fixture.human, "utf8"), "# Human original notes");
    assert.equal(existsSync(getDeploymentJournalPath(fixture.userHome)), false);
  } finally {
    rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});

