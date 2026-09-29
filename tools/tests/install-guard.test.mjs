import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const INSTALL_PATH = resolve(REPO_ROOT, "install.ps1");

function getPowerShellPath() {
  const candidates = process.platform === "win32"
    ? [
        join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "powershell.exe",
        "pwsh.exe",
        "pwsh",
      ]
    : [
        "pwsh",
        "/usr/bin/pwsh",
        "/usr/local/bin/pwsh",
        "/opt/microsoft/powershell/7/pwsh",
      ];
  for (const c of candidates) {
    try {
      const res = spawnSync(c, ["-NoProfile", "-Command", "Write-Output ps-ok"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      if (res.status === 0 && (res.stdout || "").includes("ps-ok")) {
        return c;
      }
    } catch {}
  }
  return null;
}

const POWERSHELL_PATH = getPowerShellPath();

test("install.ps1: refuses in-place target (-HarnessRoot .) without mutating repo", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const agentsMdPath = join(REPO_ROOT, "agent", "AGENTS.md");
  const beforeContent = readFileSync(agentsMdPath, "utf8");

  const res = spawnSync(POWERSHELL_PATH, [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", INSTALL_PATH,
    "-HarnessRoot", ".",
    "-NonInteractive",
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  assert.notEqual(res.status, 0, "Installer must fail with non-zero exit code on -HarnessRoot .");
  const output = (res.stdout || "") + (res.stderr || "");
  assert.match(output, /Cannot install harness into the repository root/);
  assert.match(output, /Use in-place install with "--root \."/);

  const afterContent = readFileSync(agentsMdPath, "utf8");
  assert.equal(afterContent, beforeContent, "agent/AGENTS.md must remain unmutated");
  assert.ok(afterContent.includes("<HARNESS>"), "agent/AGENTS.md placeholder <HARNESS> must be preserved");
});

test("install.ps1: refuses subdirectory target inside repository root without mutation", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const targetDir = join(REPO_ROOT, "agent");
  const agentsMdPath = join(REPO_ROOT, "agent", "AGENTS.md");
  const beforeContent = readFileSync(agentsMdPath, "utf8");

  const res = spawnSync(POWERSHELL_PATH, [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", INSTALL_PATH,
    "-HarnessRoot", targetDir,
    "-NonInteractive",
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  assert.notEqual(res.status, 0, "Installer must fail with non-zero exit code on repo subdirectory target");
  const output = (res.stdout || "") + (res.stderr || "");
  assert.match(output, /Cannot install harness into a subdirectory of the repository root/);

  const afterContent = readFileSync(agentsMdPath, "utf8");
  assert.equal(afterContent, beforeContent, "agent/AGENTS.md must remain unmutated");
});

test("install.ps1: accepts normal target outside repository", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const tmpHome = mkdtempSync(join(tmpdir(), "install-normal-"));
  const tmpHarness = join(tmpHome, "omp-workflow");
  try {
    const res = spawnSync(POWERSHELL_PATH, [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", INSTALL_PATH,
      "-UserHome", tmpHome,
      "-HarnessRoot", tmpHarness,
      "-SkipPlugins",
      "-NonInteractive",
    ], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    const output = (res.stdout || "") + (res.stderr || "");
    assert.doesNotMatch(output, /Cannot install harness into/);
    assert.equal(res.status, 0, `Installer must succeed for external target: ${output}`);
    assert.ok(existsSync(join(tmpHarness, "agent", "AGENTS.md")), "AGENTS.md should be installed at external target");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
