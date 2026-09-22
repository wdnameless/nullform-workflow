import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SCRIPTS = [
  "verify.sh",
  "tools/audit.sh",
  "tools/sync.sh",
];

function resolveBashExecutable() {
  // 1. Try standard 'bash'
  try {
    const res = spawnSync("bash", ["-c", "true"], { stdio: "ignore" });
    if (res.status === 0) return "bash";
  } catch {}

  // 2. On win32, check common Git Bash installations
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\PROGRA~1\\Git\\bin\\bash.exe",
      "C:\\PROGRA~1\\Git\\usr\\bin\\bash.exe",
      process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Git", "bin", "bash.exe"),
      process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Git", "bin", "bash.exe"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        try {
          const res = spawnSync(candidate, ["-c", "true"], { stdio: "ignore" });
          if (res.status === 0) return candidate;
        } catch {}
      }
    }
  }

  return null;
}

const bashBin = resolveBashExecutable();

for (const scriptRel of SCRIPTS) {
  test(`${scriptRel}: exists, valid shebang, set -e, LF-only, bash -n syntax check`, (t) => {
    const scriptPath = join(REPO_ROOT, scriptRel);

    // 1. Script must exist
    assert.ok(existsSync(scriptPath), `${scriptRel} must exist at ${scriptPath}`);

    const raw = readFileSync(scriptPath);
    const content = raw.toString("utf8");

    // 2. Starts with #!/usr/bin/env bash
    assert.ok(
      content.startsWith("#!/usr/bin/env bash"),
      `${scriptRel} must begin with #!/usr/bin/env bash`
    );

    // 3. Contains set -e
    assert.ok(
      /(^|\n)\s*set\s+-[^\n]*e/m.test(content),
      `${scriptRel} must contain 'set -e'`
    );

    // 4. LF line endings only (no \r / 0x0D)
    assert.ok(
      !raw.includes(0x0d),
      `${scriptRel} must use LF line endings only (no CRLF)`
    );

    // 5. bash -n syntax check
    if (!bashBin) {
      t.skip("bash is not available or not runnable on this system");
      return;
    }

    const res = spawnSync(bashBin, ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(
      res.status,
      0,
      `bash -n ${scriptRel} failed with status ${res.status}: ${res.stderr || res.stdout}`
    );
  });
}
