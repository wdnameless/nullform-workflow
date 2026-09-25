import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "tools/install-harness.mjs");
const SH_PATH = resolve(REPO_ROOT, "install.sh");
import { createTempDir } from "./test-helpers.mjs";


function getBashPath() {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        "bash.exe",
        "bash",
      ]
    : [
        "/bin/bash",
        "/usr/bin/bash",
        "/usr/local/bin/bash",
        "bash",
      ];
  for (const c of candidates) {
    try {
      const res = spawnSync(c, ["--version"], { encoding: "utf8" });
      if (res.status === 0 && (res.stdout || "").includes("bash")) {
        if (c === "bash" || c === "bash.exe") {
          const whichCmd = process.platform === "win32" ? "where" : "which";
          const whichRes = spawnSync(whichCmd, [c], { encoding: "utf8" });
          if (whichRes.status === 0 && whichRes.stdout.trim()) {
            return whichRes.stdout.trim().split(/\r?\n/)[0];
          }
        }
        return c;
      }
    } catch {}
  }
  return null;
}

test("dry-run does not write files or directories to root", () => {
  const tempRoot = join(tmpdir(), `harness-dry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const res = spawnSync(process.execPath, [
      SCRIPT_PATH,
      "--dry-run",
      "--harness",
      "claude",
      "--root",
      tempRoot,
    ], {
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /dry-run/i);
    assert.equal(existsSync(tempRoot), false, "Dry-run should not create the target root directory");
  } finally {
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

test("installation creates Claude adapter (CLAUDE.md) with substituted <HARNESS> and <= 60 lines", () => {
  const tempRoot = createTempDir("harness-claude-");
  try {
    const res = spawnSync(process.execPath, [
      SCRIPT_PATH,
      "--harness",
      "claude",
      "--root",
      tempRoot,
    ], {
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `Failed: ${res.stderr}`);
    const claudeMdPath = join(tempRoot, "CLAUDE.md");
    assert.equal(existsSync(claudeMdPath), true, "CLAUDE.md must exist in target root");

    const content = readFileSync(claudeMdPath, "utf8");
    const lines = content.trim().split("\n");
    assert.ok(lines.length <= 60, `CLAUDE.md must be <= 60 lines, got ${lines.length}`);
    assert.equal(content.includes("<HARNESS>"), false, "All <HARNESS> placeholders must be substituted");

    const slashRoot = tempRoot.replace(/\\/g, "/");
    assert.ok(content.includes(slashRoot), `CLAUDE.md must contain resolved path ${slashRoot}`);
    assert.ok(content.includes("workflow.mjs"), "CLAUDE.md must mention workflow.mjs");
    assert.ok(content.includes("dashboard"), "CLAUDE.md must mention dashboard");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installation creates Codex adapter (AGENTS.md) with substituted <HARNESS>", () => {
  const tempRoot = createTempDir("harness-codex-");
  try {
    const res = spawnSync(process.execPath, [
      SCRIPT_PATH,
      "--harness",
      "codex",
      "--root",
      tempRoot,
    ], {
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `Failed: ${res.stderr}`);
    const agentsMdPath = join(tempRoot, "AGENTS.md");
    assert.equal(existsSync(agentsMdPath), true, "AGENTS.md must exist in target root for Codex");

    const content = readFileSync(agentsMdPath, "utf8");
    const lines = content.trim().split("\n");
    assert.ok(lines.length <= 60, `AGENTS.md must be <= 60 lines, got ${lines.length}`);
    assert.equal(content.includes("<HARNESS>"), false, "All <HARNESS> placeholders must be substituted");

    const slashRoot = tempRoot.replace(/\\/g, "/");
    assert.ok(content.includes(slashRoot), `AGENTS.md must contain resolved path ${slashRoot}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installation creates OpenCode adapter (AGENTS.md + opencode.json)", () => {
  const tempRoot = createTempDir("harness-opencode-");
  try {
    const res = spawnSync(process.execPath, [
      SCRIPT_PATH,
      "--harness",
      "opencode",
      "--root",
      tempRoot,
    ], {
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `Failed: ${res.stderr}`);
    const agentsMdPath = join(tempRoot, "AGENTS.md");
    const opencodeJsonPath = join(tempRoot, "opencode.json");

    assert.equal(existsSync(agentsMdPath), true, "AGENTS.md must exist for OpenCode");
    assert.equal(existsSync(opencodeJsonPath), true, "opencode.json must exist for OpenCode");

    const jsonContent = JSON.parse(readFileSync(opencodeJsonPath, "utf8"));
    assert.ok(jsonContent.instructions, "opencode.json must define instructions");
    const instStr = Array.isArray(jsonContent.instructions)
      ? jsonContent.instructions.join(" ")
      : String(jsonContent.instructions);
    assert.ok(instStr.includes("AGENTS.md"), "opencode.json instructions must point to AGENTS.md");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installation creates Cursor adapter (.cursor/rules/00-workflow.mdc)", () => {
  const tempRoot = createTempDir("harness-cursor-");
  try {
    const res = spawnSync(process.execPath, [
      SCRIPT_PATH,
      "--harness",
      "cursor",
      "--root",
      tempRoot,
    ], {
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `Failed: ${res.stderr}`);
    const cursorRulePath = join(tempRoot, ".cursor", "rules", "00-workflow.mdc");
    assert.equal(existsSync(cursorRulePath), true, "00-workflow.mdc must exist for Cursor");

    const content = readFileSync(cursorRulePath, "utf8");
    const lines = content.trim().split("\n");
    assert.ok(lines.length <= 60, `Cursor rule must be <= 60 lines, got ${lines.length}`);
    assert.ok(content.startsWith("---"), "Cursor rule must start with frontmatter");
    assert.equal(content.includes("<HARNESS>"), false, "All <HARNESS> placeholders must be substituted");

    const slashRoot = tempRoot.replace(/\\/g, "/");
    assert.ok(content.includes(slashRoot), `Cursor rule must contain resolved path ${slashRoot}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installation copies core files and directory structure", () => {
  const tempRoot = createTempDir("harness-core-");
  try {
    const res = spawnSync(process.execPath, [
      SCRIPT_PATH,
      "--harness",
      "claude",
      "--root",
      tempRoot,
    ], {
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `Failed: ${res.stderr}`);
    assert.equal(existsSync(join(tempRoot, "agent", "AGENTS.md")), true);
    assert.equal(existsSync(join(tempRoot, "agent", "agents", "orchestrator.md")), true);
    assert.equal(existsSync(join(tempRoot, "rules")), true);
    assert.equal(existsSync(join(tempRoot, "tools", "workflow.mjs")), true);
    assert.equal(existsSync(join(tempRoot, "core", "PORTABLE.md")), true);
    assert.equal(existsSync(join(tempRoot, "templates")), true);
    assert.equal(existsSync(join(tempRoot, "skills")), true);
    assert.equal(existsSync(join(tempRoot, "CONTEXT.md")), true);
    assert.equal(existsSync(join(tempRoot, "README.md")), true);

    const orchestratorContent = readFileSync(join(tempRoot, "agent", "agents", "orchestrator.md"), "utf8");
    assert.equal(orchestratorContent.includes("<HARNESS>"), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installation is idempotent on repeated execution", () => {
  const tempRoot = createTempDir("harness-idempotent-");
  try {
    const res1 = spawnSync(process.execPath, [
      SCRIPT_PATH,
      "--harness",
      "claude",
      "--root",
      tempRoot,
    ], {
      encoding: "utf8",
    });
    assert.equal(res1.status, 0);

    const claudeMd1 = readFileSync(join(tempRoot, "CLAUDE.md"), "utf8");
    const fileCount1 = readdirSync(tempRoot).length;

    const res2 = spawnSync(process.execPath, [
      SCRIPT_PATH,
      "--harness",
      "claude",
      "--root",
      tempRoot,
    ], {
      encoding: "utf8",
    });
    assert.equal(res2.status, 0);

    const claudeMd2 = readFileSync(join(tempRoot, "CLAUDE.md"), "utf8");
    const fileCount2 = readdirSync(tempRoot).length;

    assert.equal(claudeMd1, claudeMd2, "Content must remain identical on repeated run");
    assert.equal(fileCount1, fileCount2, "File count in root must remain identical");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("unknown --harness exits with code 2 and helpful message on stderr", () => {
  const tempRoot = createTempDir("harness-err-");
  try {
    const res = spawnSync(process.execPath, [
      SCRIPT_PATH,
      "--harness",
      "unknown_harness_xyz",
      "--root",
      tempRoot,
    ], {
      encoding: "utf8",
    });

    assert.equal(res.status, 2, `Expected exit code 2, got ${res.status}`);
    assert.match(res.stderr, /unknown harness/i);
    assert.match(res.stderr, /claude|codex|opencode|cursor|omp/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("install.sh without node in PATH gives instruction without stack trace", (t) => {
  const bashBin = getBashPath();
  if (!bashBin) {
    t?.skip?.("bash is unavailable on this host");
    return;
  }

  const realBashPath = resolve(bashBin);
  const bashDir = dirname(realBashPath);
  const isolatedDir = createTempDir("isolated-bash-");
  try {
    let isolatedPath;
    if (process.platform === "win32") {
      isolatedPath = bashDir;
    } else {
      const bashLink = join(isolatedDir, "bash");
      try {
        symlinkSync(realBashPath, bashLink);
        isolatedPath = isolatedDir;
      } catch {
        isolatedPath = bashDir;
      }
    }

    const res = spawnSync(realBashPath, [SH_PATH, "--help"], {
      encoding: "utf8",
      env: {
        PATH: isolatedPath,
        SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows",
      },
    });

    assert.equal(res.error, undefined, `Spawn failed: ${res.error?.message}`);
    assert.notEqual(res.status, 0, "Must exit with non-zero when node is absent");
    assert.ok(res.stderr, "stderr must be present");
    assert.match(res.stderr, /node.*not found|requires node/i);
    assert.doesNotMatch(res.stderr, /at Module\._resolveFilename/i, "Must not dump a Node/JS stack trace");
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test("generated markdown adapter does not reference unsupported verification artifact kind", () => {
  const tempRoot = createTempDir("harness-adapter-check-");
  try {
    const res = spawnSync(process.execPath, [
      SCRIPT_PATH,
      "--harness",
      "claude",
      "--root",
      tempRoot,
    ], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    const claudeMdPath = join(tempRoot, "CLAUDE.md");
    const content = readFileSync(claudeMdPath, "utf8");

    assert.equal(
      content.includes("--kind verification"),
      false,
      "Adapter must not instruct user to record non-existent '--kind verification' artifact"
    );
    assert.ok(
      content.includes("--kind manifest"),
      "Adapter must reference valid artifact kinds like manifest"
    );
    assert.ok(
      content.includes("--kind oracle"),
      "Adapter must reference valid artifact kinds like oracle"
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
