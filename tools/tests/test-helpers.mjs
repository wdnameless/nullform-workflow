import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Creates a unique temporary directory with an optional prefix.
 * @param {string} [prefix]
 * @returns {string}
 */
export function createTempDir(prefix = "test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Creates a temporary git repository with an initial commit.
 * @param {string} [prefix]
 * @returns {string}
 */
export function createGitRepo(prefix = "git-test-") {
  const dir = createTempDir(prefix);
  spawnSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
  spawnSync("git", ["config", "user.name", "TestRunner"], { cwd: dir, windowsHide: true });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, windowsHide: true });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, windowsHide: true });
  writeFileSync(join(dir, "initial.txt"), "hello\n", "utf8");
  writeFileSync(join(dir, "a.js"), "line1\nline2\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: dir, windowsHide: true });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, windowsHide: true });
  return dir;
}
