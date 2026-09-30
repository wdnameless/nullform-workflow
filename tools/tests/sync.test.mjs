import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../sync.mjs", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sync-regression-"));
  const repo = join(root, "repo"), harness = join(root, "harness");
  const agentDir = join(root, "omp", "agent"), agentsRoot = join(root, "agents");
  mkdirSync(join(repo, "agent"), { recursive: true });
  mkdirSync(join(harness, "agent"), { recursive: true });
  writeFileSync(join(repo, "install.ps1"), "# repository marker\n");
  writeFileSync(join(repo, "agent", "models.yml.example"), "# repository marker\n");
  return {
    root, repo, harness, agentDir, agentsRoot,
    run: (...args) => spawnSync(process.execPath, [CLI,
      "--repo", repo, "--harness", harness, "--agent-dir", agentDir,
      "--agents-root", agentsRoot, ...args,
    ], { encoding: "utf8", timeout: 30000, windowsHide: true }),
  };
}
function makeDirLink(target, linkPath) {
  symlinkSync(target, linkPath, "junction");
}

function makeFileLink(target, linkPath) {
  try {
    symlinkSync(target, linkPath, "file");
    return true;
  } catch (err) {
    if (err.code !== "EPERM") throw err;
    return false;
  }
}


test("refused promote leaves earlier files unchanged even when a later file is newer in repo", () => {
  const f = fixture();
  try {
    const first = join(f.repo, "agent", "AGENTS.md");
    const liveFirst = join(f.harness, "agent", "AGENTS.md");
    const later = join(f.repo, "agent", "plugins.json");
    const liveLater = join(f.harness, "agent", "plugins.json");
    writeFileSync(first, "repo old\n");
    writeFileSync(liveFirst, "live new\n");
    writeFileSync(later, "repo new\n");
    writeFileSync(liveLater, "live old\n");
    const now = Date.now() / 1000;
    utimesSync(first, now - 120, now - 120);
    utimesSync(liveFirst, now, now);
    utimesSync(liveLater, now - 120, now - 120);
    utimesSync(later, now, now);
    const res = f.run("--promote", "--only", "agent/");
    assert.equal(res.status, 2, res.stderr || res.stdout);
    assert.equal(readFileSync(first, "utf8"), "repo old\n");
    assert.equal(readFileSync(later, "utf8"), "repo new\n");
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("missing OMP law copy is drift, and deploy restores it", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "agent", "AGENTS.md"), "current law\n");
    writeFileSync(join(f.harness, "agent", "AGENTS.md"), "current law\n");
    const copy = join(f.agentDir, "AGENTS.md");
    const checked = f.run("--check", "--only", "AGENTS.md");
    assert.equal(checked.status, 1, checked.stderr || checked.stdout);
    assert.match(checked.stdout, /DRIFT\s+~\/.omp\/agent\/AGENTS\.md/);
    const before = f.run("--check", "--only", "AGENTS.md", "--json");
    assert.equal(JSON.parse(before.stdout).checked, 2);
    assert.equal(existsSync(copy), false);
    const deployed = f.run("--deploy", "--only", "AGENTS.md");
    assert.equal(deployed.status, 0, deployed.stderr || deployed.stdout);
    assert.equal(readFileSync(copy, "utf8"), "current law\n");
    const after = f.run("--check", "--only", "AGENTS.md", "--json");
    assert.equal(after.status, 0);
    assert.equal(JSON.parse(after.stdout).checked, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("invalid explicit repo fails and JSON remains parseable on drift", () => {
  const f = fixture();
  try {
    const bad = spawnSync(process.execPath, [CLI,
      "--harness", f.harness, "--repo", join(f.root, "does-not-exist"),
    ], { encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /explicit path/);
    mkdirSync(join(f.repo, "tools"), { recursive: true });
    mkdirSync(join(f.harness, "tools"), { recursive: true });
    writeFileSync(join(f.repo, "tools", "workflow.mjs"), "repo\n");
    writeFileSync(join(f.harness, "tools", "workflow.mjs"), "live\n");
    const res = f.run("--json", "--only", "workflow.mjs");
    assert.equal(res.status, 1);
    const data = JSON.parse(res.stdout);
    assert.equal(data.ok, false);
    assert.deepEqual(data.drift, ["tools/workflow.mjs"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("promote with relative root preserves punctuation and unrelated text while substituting real root", () => {
  const f = fixture();
  try {
    const slashHarness = f.harness.replace(/\\/g, "/");
    const liveFile = join(f.harness, "agent", "AGENTS.md");
    const repoFile = join(f.repo, "agent", "AGENTS.md");
    const liveContent = `workflow.mjs ... 1.2\nRun node '${slashHarness}/tools/workflow.mjs'\nfoo.bar.baz 2.4.1\n`;
    writeFileSync(liveFile, liveContent);
    writeFileSync(repoFile, "old repo\n");
    const now = Date.now() / 1000;
    utimesSync(repoFile, now - 120, now - 120);
    utimesSync(liveFile, now, now);

    // Call with relative harness root "." from inside f.harness directory
    const res = spawnSync(process.execPath, [CLI,
      "--repo", f.repo, "--harness", ".", "--agent-dir", f.agentDir,
      "--agents-root", f.agentsRoot, "--promote", "--only", "AGENTS.md",
    ], { cwd: f.harness, encoding: "utf8", timeout: 30000, windowsHide: true });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    const promoted = readFileSync(repoFile, "utf8");
    const expected = `workflow.mjs ... 1.2\nRun node '<HARNESS>/tools/workflow.mjs'\nfoo.bar.baz 2.4.1\n`;
    assert.equal(promoted, expected);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("three divergent rule copies make --check non-zero and --deploy converges all three", () => {
  const f = fixture();
  try {
    const repoRule = join(f.repo, "rules", "enterprise-directives.md");
    const harnessRule = join(f.harness, "rules", "enterprise-directives.md");
    const agentDirRule = join(f.agentDir, "rules", "enterprise-directives.md");
    const agentsRootRule = join(f.agentsRoot, "rules", "enterprise-directives.md");

    mkdirSync(join(f.repo, "rules"), { recursive: true });
    mkdirSync(join(f.harness, "rules"), { recursive: true });
    mkdirSync(join(f.agentDir, "rules"), { recursive: true });
    mkdirSync(join(f.agentsRoot, "rules"), { recursive: true });

    writeFileSync(repoRule, "# Directives\nRun <HARNESS>/tools/workflow.mjs\nv2\n");
    writeFileSync(harnessRule, "# Directives\nOld harness\n");
    writeFileSync(agentDirRule, "# Directives\nOld agentDir\n");
    writeFileSync(agentsRootRule, "# Directives\nOld agentsRoot\n");

    const check1 = f.run("--check", "--only", "enterprise-directives.md", "--json");
    assert.equal(check1.status, 1, check1.stderr || check1.stdout);
    const data1 = JSON.parse(check1.stdout);
    assert.equal(data1.ok, false);
    assert.equal(data1.checked, 3, "must check all three rule copies");

    const deploy = f.run("--deploy", "--only", "enterprise-directives.md");
    assert.equal(deploy.status, 0, deploy.stderr || deploy.stdout);

    const slashHarness = f.harness.replace(/\\/g, "/");
    const expectedContent = `# Directives\nRun ${slashHarness}/tools/workflow.mjs\nv2\n`;
    assert.equal(readFileSync(harnessRule, "utf8"), expectedContent);
    assert.equal(readFileSync(agentDirRule, "utf8"), expectedContent);
    assert.equal(readFileSync(agentsRootRule, "utf8"), expectedContent);

    const check2 = f.run("--check", "--only", "enterprise-directives.md", "--json");
    assert.equal(check2.status, 0, check2.stderr || check2.stdout);
    const data2 = JSON.parse(check2.stdout);
    assert.equal(data2.ok, true);
    assert.equal(data2.checked, 3);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("an unusable root is refused non-zero without touching files", () => {
  const f = fixture();
  try {
    const repoMarker = join(f.repo, "agent", "AGENTS.md");
    writeFileSync(repoMarker, "marker original\n");
    const mtimeBefore = Date.now() - 50000;
    utimesSync(repoMarker, mtimeBefore / 1000, mtimeBefore / 1000);

    const res = spawnSync(process.execPath, [CLI,
      "--repo", f.repo, "--harness", "/", "--promote",
    ], { encoding: "utf8", timeout: 30000, windowsHide: true });

    assert.notEqual(res.status, 0);
    assert.match(res.stderr + res.stdout, /unusable|REFUSED/i);
    assert.equal(readFileSync(repoMarker, "utf8"), "marker original\n");
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("destination directory junction escaping harness fails preflight and leaves earlier drifted file unchanged", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentinel.txt"), "outside sentinel\n");

    // Earlier file in manifest: agent/AGENTS.md
    writeFileSync(join(f.repo, "agent", "AGENTS.md"), "repo new\n");
    writeFileSync(join(f.harness, "agent", "AGENTS.md"), "live old\n");

    // Later destination's parent: agent/agents is junction to outside
    makeDirLink(outside, join(f.harness, "agent", "agents"));
    mkdirSync(join(f.repo, "agent", "agents"), { recursive: true });
    writeFileSync(join(f.repo, "agent", "agents", "orchestrator.md"), "repo orchestrator\n");

    const res = f.run("--deploy", "--only", "agent/");
    assert.notEqual(res.status, 0, "must fail nonzero on escaping junction");
    assert.match(res.stderr + res.stdout, /REFUSED/i);

    // Earlier file remains unchanged (no partial writes)
    assert.equal(readFileSync(join(f.harness, "agent", "AGENTS.md"), "utf8"), "live old\n");
    // External sentinel unchanged
    assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "outside sentinel\n");
    // External dir did not receive deployed file
    assert.equal(existsSync(join(outside, "orchestrator.md")), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("promotion source junction escaping live root is refused before copying into repo", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "orchestrator.md"), "sensitive outside content\n");

    mkdirSync(join(f.repo, "agent", "agents"), { recursive: true });
    writeFileSync(join(f.repo, "agent", "agents", "orchestrator.md"), "original repo\n");
    const now = Date.now() / 1000;
    utimesSync(join(f.repo, "agent", "agents", "orchestrator.md"), now - 120, now - 120);

    // Live agents dir points to outside
    makeDirLink(outside, join(f.harness, "agent", "agents"));

    const res = f.run("--promote", "--only", "orchestrator.md");
    assert.notEqual(res.status, 0, "must fail nonzero on promote source escaping live root");
    assert.match(res.stderr + res.stdout, /REFUSED/i);

    assert.equal(readFileSync(join(f.repo, "agent", "agents", "orchestrator.md"), "utf8"), "original repo\n");
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("dangling destination link refuses without creating external target or updating earlier drifted file", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "agent", "AGENTS.md"), "repo new\n");
    writeFileSync(join(f.harness, "agent", "AGENTS.md"), "live old\n");

    mkdirSync(join(f.repo, "agent", "agents"), { recursive: true });
    writeFileSync(join(f.repo, "agent", "agents", "orchestrator.md"), "repo orchestrator\n");

    const outsideTarget = join(f.root, "outside-dangling");
    const outsideMissingFile = join(outsideTarget, "orchestrator.md");

    const destFile = join(f.harness, "agent", "agents", "orchestrator.md");
    mkdirSync(join(f.harness, "agent", "agents"), { recursive: true });
    const fileLinkOk = makeFileLink(outsideMissingFile, destFile);
    if (!fileLinkOk) {
      rmSync(join(f.harness, "agent", "agents"), { recursive: true, force: true });
      mkdirSync(outsideTarget, { recursive: true });
      makeDirLink(outsideTarget, join(f.harness, "agent", "agents"));
      rmSync(outsideTarget, { recursive: true, force: true });
    }

    const res = f.run("--deploy", "--only", "agent/");
    assert.notEqual(res.status, 0, "must refuse nonzero on dangling destination link");
    assert.match(res.stderr + res.stdout, /REFUSED/i);

    assert.equal(readFileSync(join(f.harness, "agent", "AGENTS.md"), "utf8"), "live old\n");
    assert.equal(existsSync(outsideMissingFile), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("missing child under out-of-root junction fails preflight on check and deploy", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside");
    mkdirSync(outside, { recursive: true });
    makeDirLink(outside, join(f.harness, "agent", "agents"));

    mkdirSync(join(f.repo, "agent", "agents"), { recursive: true });
    writeFileSync(join(f.repo, "agent", "agents", "orchestrator.md"), "repo content\n");

    const checkRes = f.run("--check", "--only", "orchestrator.md");
    assert.notEqual(checkRes.status, 0, "--check must fail on out-of-root junction");
    assert.match(checkRes.stderr + checkRes.stdout, /REFUSED/i);

    const deployRes = f.run("--deploy", "--only", "orchestrator.md");
    assert.notEqual(deployRes.status, 0, "--deploy must fail on out-of-root junction");
    assert.match(deployRes.stderr + deployRes.stdout, /REFUSED/i);
    assert.equal(existsSync(join(outside, "orchestrator.md")), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("promote substitutes harness root at CR/LF boundary while leaving unrelated prefixes unchanged", () => {
  const f = fixture();
  try {
    const slashHarness = f.harness.replace(/\\/g, "/");
    const liveFile = join(f.harness, "agent", "AGENTS.md");
    const repoFile = join(f.repo, "agent", "AGENTS.md");

    const liveContent = `Root: ${slashHarness}\nnext line\nWindows: ${slashHarness}\r\nnext line\nPrefix: ${slashHarness}-other\nUnrelated: ${slashHarness}.\n`;
    writeFileSync(liveFile, liveContent);
    writeFileSync(repoFile, "old repo\n");
    const now = Date.now() / 1000;
    utimesSync(repoFile, now - 120, now - 120);
    utimesSync(liveFile, now, now);

    const res = f.run("--promote", "--only", "AGENTS.md");
    assert.equal(res.status, 0, res.stderr || res.stdout);

    const promoted = readFileSync(repoFile, "utf8");
    const expected = `Root: <HARNESS>\nnext line\nWindows: <HARNESS>\nnext line\nPrefix: ${slashHarness}-other\nUnrelated: <HARNESS>.\n`;
    assert.equal(promoted, expected);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("dangling harness root link refuses on --check and --deploy without creating target", () => {
  const f = fixture();
  try {
    const danglingHarness = join(f.root, "dangling-harness");
    const nonExistentTarget = join(f.root, "does-not-exist");
    makeDirLink(nonExistentTarget, danglingHarness);

    const checkRes = spawnSync(process.execPath, [CLI,
      "--repo", f.repo, "--harness", danglingHarness, "--agent-dir", f.agentDir,
      "--agents-root", f.agentsRoot, "--check",
    ], { encoding: "utf8", timeout: 30000, windowsHide: true });

    assert.notEqual(checkRes.status, 0, "--check must fail nonzero when harness root is a dangling link");
    assert.match(checkRes.stderr + checkRes.stdout, /escapes declared root|unresolved link|REFUSED/i);
    assert.equal(existsSync(nonExistentTarget), false, "target must not be created on --check");

    const deployRes = spawnSync(process.execPath, [CLI,
      "--repo", f.repo, "--harness", danglingHarness, "--agent-dir", f.agentDir,
      "--agents-root", f.agentsRoot, "--deploy",
    ], { encoding: "utf8", timeout: 30000, windowsHide: true });

    assert.notEqual(deployRes.status, 0, "--deploy must fail nonzero when harness root is a dangling link");
    assert.match(deployRes.stderr + deployRes.stdout, /escapes declared root|unresolved link|REFUSED/i);
    assert.equal(existsSync(nonExistentTarget), false, "target must not be created on --deploy");
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("stale user extension detects drift via liveRel and converges on deploy", () => {
  const f = fixture();
  try {
    const extRel = join("agent", "extensions", "nullform-jev.ts");
    const repoExt = join(f.repo, extRel);
    const harnessExt = join(f.harness, extRel);
    const userExt = join(f.agentDir, "extensions", "nullform-jev.ts");

    mkdirSync(join(f.repo, "agent", "extensions"), { recursive: true });
    mkdirSync(join(f.harness, "agent", "extensions"), { recursive: true });
    mkdirSync(join(f.agentDir, "extensions"), { recursive: true });

    const currentExtContent = "// nullform-jev current repo code\nexport default () => {};\n";
    const staleExtContent = "// nullform-jev stale user code\nexport default () => {};\n";

    writeFileSync(repoExt, currentExtContent);
    writeFileSync(harnessExt, currentExtContent);
    writeFileSync(userExt, staleExtContent);

    // 1. --check detects drift on the stale user extension
    const checkRes = f.run("--check", "--only", "nullform-jev.ts");
    assert.equal(checkRes.status, 1, checkRes.stderr || checkRes.stdout);
    assert.match(checkRes.stdout, /DRIFT\s+agent\/extensions\/nullform-jev\.ts/);

    // 2. --deploy copies current repo extension to user directory
    const deployRes = f.run("--deploy", "--only", "nullform-jev.ts");
    assert.equal(deployRes.status, 0, deployRes.stderr || deployRes.stdout);
    assert.equal(readFileSync(userExt, "utf8"), currentExtContent);

    // 3. --check succeeds with 0 drift after deployment
    const checkAfter = f.run("--check", "--only", "nullform-jev.ts");
    assert.equal(checkAfter.status, 0, checkAfter.stderr || checkAfter.stdout);
    assert.doesNotMatch(checkAfter.stdout, /DRIFT/);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
