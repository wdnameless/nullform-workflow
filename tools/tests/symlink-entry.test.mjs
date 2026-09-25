/**
 * tools/tests/symlink-entry.test.mjs
 * Regression tests for symlink/junction CLI entry guards:
 * Proves that invoking tools through a symlink or junction directory
 * resolves and executes main() instead of silently no-oping (exit 0, empty output).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function createDirLink(target, linkPath) {
  if (process.platform === "win32") {
    const res = spawnSync("cmd.exe", ["/d", "/c", "mklink", "/J", resolve(linkPath), resolve(target)], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status !== 0) {
      throw new Error(`Failed to create junction: ${res.stderr || res.stdout}`);
    }
  } else {
    symlinkSync(target, linkPath, "dir");
  }
}

function removeDirLink(linkPath) {
  if (!existsSync(linkPath)) return;
  if (process.platform === "win32") {
    spawnSync("cmd.exe", ["/d", "/c", "rmdir", resolve(linkPath)], {
      windowsHide: true,
    });
  } else {
    rmSync(linkPath, { recursive: true, force: true });
  }
}

test("CLI tools execute main() when invoked through a symlink/junction", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "symlink-guard-test-"));
  const linkDir = join(tempDir, "linkrepo");

  try {
    createDirLink(repoRoot, linkDir);
  } catch (err) {
    t.skip(`Skipping symlink test: OS refused symlink creation: ${err.message}`);
    rmSync(tempDir, { recursive: true, force: true });
    return;
  }

  try {
    // 1. verify.mjs --help
    const verifyScript = join(linkDir, "tools", "verify.mjs");
    const verifyRes = spawnSync(process.execPath, [verifyScript, "--help"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(verifyRes.status, 0, `verify.mjs exit code: ${verifyRes.status}, stderr: ${verifyRes.stderr}`);
    assert.match(
      verifyRes.stdout,
      /Usage:\s+node\s+tools\/verify\.mjs/i,
      "verify.mjs --help through symlink must print usage instead of empty output"
    );

    // 2. workflow.mjs status
    const workflowScript = join(linkDir, "tools", "workflow.mjs");
    const workflowRes = spawnSync(process.execPath, [workflowScript, "status"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(workflowRes.status, 0, `workflow.mjs exit code: ${workflowRes.status}, stderr: ${workflowRes.stderr}`);
    assert.ok(
      workflowRes.stdout.trim().length > 0,
      "workflow.mjs status through symlink must produce non-empty status output"
    );

    // 3. code-size.mjs check --root .
    const codeSizeScript = join(linkDir, "tools", "code-size.mjs");
    const codeSizeRes = spawnSync(process.execPath, [codeSizeScript, "check", "--root", "."], {
      encoding: "utf8",
      cwd: linkDir,
      windowsHide: true,
    });
    assert.ok(
      codeSizeRes.stdout.trim().length > 0 || codeSizeRes.stderr.trim().length > 0,
      "code-size.mjs check through symlink must produce non-empty check output"
    );
    assert.match(
      codeSizeRes.stdout + codeSizeRes.stderr,
      /code-size:/i,
      "code-size.mjs output through symlink must contain 'code-size:' prefix"
    );
  } finally {
    removeDirLink(linkDir);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
