import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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

function extractWorkflowGateScript(workflowPath) {
  const content = readFileSync(workflowPath, "utf8");
  const lines = content.split(/\r?\n/);
  let capturing = false;
  let indent = 0;
  const scriptLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("name: Workflow gate validation")) {
      for (let j = i + 1; j < lines.length; j++) {
        const rLine = lines[j];
        if (rLine.includes("run: |")) {
          i = j;
          capturing = true;
          for (let k = j + 1; k < lines.length; k++) {
            if (lines[k].trim().length > 0) {
              const match = lines[k].match(/^(\s+)/);
              indent = match ? match[1].length : 10;
              break;
            }
          }
          break;
        }
      }
      continue;
    }

    if (capturing) {
      if (line.match(/^ {4,6}- name:/) ||
          (line.trim().length > 0 && !line.startsWith(" ".repeat(indent)))) {
        break;
      }
      if (line.startsWith(" ".repeat(indent))) {
        scriptLines.push(line.slice(indent));
      } else if (line.trim().length === 0) {
        scriptLines.push("");
      } else {
        scriptLines.push(line.trimStart());
      }
    }
  }

  return scriptLines.join("\n").trim();
}

function setupTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ci-gate-test-"));
  const git = (cmd) => {
    const res = spawnSync("git", cmd, { cwd: dir, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`git ${cmd.join(" ")} failed: ${res.stderr || res.stdout}`);
    }
    return res.stdout;
  };

  git(["init"]);
  git(["config", "user.name", "CI Test"]);
  git(["config", "user.email", "ci@example.com"]);
  git(["config", "commit.gpgSign", "false"]);
  // `git commit` can spawn `git gc --auto` in the background, which keeps
  // writing inside .git while the test removes the fixture. On Linux that
  // surfaced as `ENOTEMPTY: rmdir '.../.git'`; disabling auto-gc removes the
  // race at its source instead of only retrying the removal.
  git(["config", "gc.auto", "0"]);
  git(["config", "maintenance.auto", "false"]);

  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(
    join(dir, "tools", "workflow.mjs"),
    `const args = process.argv.slice(2);\n` +
    `console.log("MOCK check-ci called with:", args.join(" "));\n` +
    `process.exit(0);\n`,
    "utf8"
  );

  writeFileSync(join(dir, "README.md"), "# Init\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  // If jq is not available in PATH, provide a shim in test repo's bin
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const jqProbe = spawnSync(bashBin, ["-c", "command -v jq"], { stdio: "ignore" });
  if (jqProbe.status !== 0) {
    writeFileSync(
      join(binDir, "jq"),
      `#!/usr/bin/env bash\n` +
      `node -e '\n` +
      `const fs = require("fs");\n` +
      `try {\n` +
      `  const data = JSON.parse(fs.readFileSync(0, "utf8"));\n` +
      `  for (const item of (Array.isArray(data) ? data : [])) {\n` +
      `    if (item && item.name) console.log(item.name);\n` +
      `  }\n` +
      `} catch {}\n` +
      `'\n`,
      { mode: 0o755 }
    );
  }

  return { dir, git };
}

function runGateScript(script, repoDir, env) {
  const binDir = join(repoDir, "bin");
  const fullEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    BASE_REF: "main",
    ...env,
  };
  return spawnSync(bashBin, ["-e", "-c", script], {
    cwd: repoDir,
    env: fullEnv,
    encoding: "utf8",
  });
}


test("R02: T2 fails when changed OpenSpec directory is deleted", (t) => {
  if (!bashBin) {
    t.skip("bash is not available or not runnable on this system");
    return;
  }
  const gateScript = extractWorkflowGateScript(
    join(REPO_ROOT, ".github/workflows/repo-gate.yml")
  );
  const { dir, git } = setupTestRepo();
  try {
    const changeDir = join(dir, "openspec", "changes", "feat-deleted");
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(join(changeDir, "manifest.md"), "# Manifest\nR01\n", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "add feat-deleted"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);

    git(["rm", "-r", "openspec/changes/feat-deleted"]);
    git(["commit", "-m", "delete feat-deleted"]);

    assert.equal(existsSync(changeDir), false);

    const res = runGateScript(gateScript, dir, {
      LABELS_JSON: JSON.stringify([{ name: "workflow:T2" }]),
      BASE_REF: "main",
    });

    assert.notEqual(res.status, 0, "Gate must fail when directory was deleted");
    const output = (res.stderr || "") + (res.stdout || "");
    assert.match(output, /missing\/deleted|does not exist or was deleted/i);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("R02: T2 fails when changed OpenSpec directory name contains spaces", (t) => {
  if (!bashBin) {
    t.skip("bash is not available or not runnable on this system");
    return;
  }
  const gateScript = extractWorkflowGateScript(
    join(REPO_ROOT, ".github/workflows/repo-gate.yml")
  );
  const { dir, git } = setupTestRepo();
  try {
    const changeDir = join(dir, "openspec", "changes", "feat with spaces");
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(join(changeDir, "manifest.md"), "# Manifest\nR01\n", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "add feat with spaces"]);

    const res = runGateScript(gateScript, dir, {
      LABELS_JSON: JSON.stringify([{ name: "workflow:T2" }]),
      BASE_REF: "main",
    });

    assert.notEqual(res.status, 0, "Gate must fail when name contains spaces");
    const output = (res.stderr || "") + (res.stdout || "");
    assert.match(output, /invalid|whitespace/i);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("R02: T2 fails when no existing directory reaches check-ci (zero-validation)", (t) => {
  if (!bashBin) {
    t.skip("bash is not available or not runnable on this system");
    return;
  }
  const gateScript = extractWorkflowGateScript(
    join(REPO_ROOT, ".github/workflows/repo-gate.yml")
  );
  const { dir, git } = setupTestRepo();
  try {
    writeFileSync(join(dir, "README.md"), "# Updated README\n", "utf8");
    git(["add", "README.md"]);
    git(["commit", "-m", "update readme"]);

    const res = runGateScript(gateScript, dir, {
      LABELS_JSON: JSON.stringify([{ name: "workflow:T2" }]),
      BASE_REF: "main",
    });

    assert.notEqual(res.status, 0, "Gate must fail when no openspec changes modified for T2");
    const output = (res.stderr || "") + (res.stdout || "");
    assert.match(output, /needs openspec\/changes|No OpenSpec change validated/i);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

;

;

;

test("R02: git diff failure exits non-zero without silent || true masking", (t) => {
  if (!bashBin) {
    t.skip("bash is not available or not runnable on this system");
    return;
  }
  const gateScript = extractWorkflowGateScript(
    join(REPO_ROOT, ".github/workflows/repo-gate.yml")
  );
  const { dir } = setupTestRepo();
  try {
    const res = runGateScript(gateScript, dir, {
      LABELS_JSON: JSON.stringify([{ name: "workflow:T2" }]),
      BASE_REF: "nonexistent-branch-xyz",
    });

    assert.notEqual(res.status, 0, "Git diff failure must not be masked by || true");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
