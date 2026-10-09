import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../sync.mjs", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sync-backup-test-"));
  const repo = join(root, "repo"), harness = join(root, "harness");
  const agentDir = join(root, "omp", "agent"), agentsRoot = join(root, "agents");
  mkdirSync(join(repo, "agent"), { recursive: true });
  mkdirSync(join(harness, "agent"), { recursive: true });
  mkdirSync(join(repo, "rules"), { recursive: true });
  mkdirSync(join(harness, "rules"), { recursive: true });
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

function getBackups(dir, basename) {
  if (!existsSync(dir)) return [];
  const prefix = `${basename}.bak-`;
  return readdirSync(dir)
    .filter(name => name.startsWith(prefix))
    .sort();
}

test("deploy with content difference creates backup with live-before content", () => {
  const f = fixture();
  try {
    const repoRule = join(f.repo, "rules", "enterprise-directives.md");
    const liveRule = join(f.harness, "rules", "enterprise-directives.md");
    const liveBeforeContent = "# Live directives before deploy\nCustom local tweak\n";
    const repoNewContent = "# Repo directives\nv2 from repo\n";

    writeFileSync(repoRule, repoNewContent);
    writeFileSync(liveRule, liveBeforeContent);

    const res = f.run("--deploy", "--only", "enterprise-directives.md");
    assert.equal(res.status, 0, res.stderr || res.stdout);

    // Live file updated
    assert.equal(readFileSync(liveRule, "utf8"), repoNewContent);

    // Backup created right next to live file
    const backups = getBackups(join(f.harness, "rules"), "enterprise-directives.md");
    assert.equal(backups.length, 1, `Expected 1 backup, found: ${JSON.stringify(backups)}`);
    const backupPath = join(f.harness, "rules", backups[0]);
    assert.equal(readFileSync(backupPath, "utf8"), liveBeforeContent);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("deploy without difference does not create backup", () => {
  const f = fixture();
  try {
    const repoRule = join(f.repo, "rules", "enterprise-directives.md");
    const liveRule = join(f.harness, "rules", "enterprise-directives.md");
    const identicalContent = "# Identical content across repo and live\n";

    writeFileSync(repoRule, identicalContent);
    writeFileSync(liveRule, identicalContent);

    const res = f.run("--deploy", "--only", "enterprise-directives.md");
    assert.equal(res.status, 0, res.stderr || res.stdout);

    const backups = getBackups(join(f.harness, "rules"), "enterprise-directives.md");
    assert.equal(backups.length, 0, "No backup should be created when content is identical");
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("backup rotation keeps maximum 3 backups per file, deleting the oldest", () => {
  const f = fixture();
  try {
    const rulesDir = join(f.harness, "rules");
    const repoRule = join(f.repo, "rules", "enterprise-directives.md");
    const liveRule = join(rulesDir, "enterprise-directives.md");

    // Pre-create 3 existing backups with distinct timestamps and mtimes
    const now = Date.now() / 1000;
    const bak1Name = "enterprise-directives.md.bak-2026-10-01T00-00-00-000Z";
    const bak2Name = "enterprise-directives.md.bak-2026-10-02T00-00-00-000Z";
    const bak3Name = "enterprise-directives.md.bak-2026-10-03T00-00-00-000Z";

    writeFileSync(join(rulesDir, bak1Name), "backup 1 content\n");
    writeFileSync(join(rulesDir, bak2Name), "backup 2 content\n");
    writeFileSync(join(rulesDir, bak3Name), "backup 3 content\n");

    utimesSync(join(rulesDir, bak1Name), now - 300, now - 300);
    utimesSync(join(rulesDir, bak2Name), now - 200, now - 200);
    utimesSync(join(rulesDir, bak3Name), now - 100, now - 100);

    // Live file has content that differs from repo
    const liveBeforeContent = "# Live content to be backed up as 4th\n";
    writeFileSync(liveRule, liveBeforeContent);
    writeFileSync(repoRule, "# Repo brand new content\n");

    const res = f.run("--deploy", "--only", "enterprise-directives.md");
    assert.equal(res.status, 0, res.stderr || res.stdout);

    // Rotation must keep exactly 3 backups
    const backups = getBackups(rulesDir, "enterprise-directives.md");
    assert.equal(backups.length, 3, `Expected exactly 3 backups after rotation, got: ${JSON.stringify(backups)}`);

    // bak1 (the oldest) must be deleted
    assert.equal(existsSync(join(rulesDir, bak1Name)), false, "Oldest backup (bak1) should have been deleted");

    // bak2 and bak3 must still exist
    assert.equal(existsSync(join(rulesDir, bak2Name)), true, "bak2 must remain");
    assert.equal(existsSync(join(rulesDir, bak3Name)), true, "bak3 must remain");

    // The newly created backup must exist and hold liveBeforeContent
    const newestBak = backups.find(b => b !== bak2Name && b !== bak3Name);
    assert.ok(newestBak, "Newest backup must exist in the backups list");
    assert.equal(readFileSync(join(rulesDir, newestBak), "utf8"), liveBeforeContent);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("dry-run shows what would be backed up without modifying files or writing backup", () => {
  const f = fixture();
  try {
    const repoRule = join(f.repo, "rules", "enterprise-directives.md");
    const liveRule = join(f.harness, "rules", "enterprise-directives.md");
    const liveBeforeContent = "# Live directives before deploy\nCustom local tweak\n";
    const repoNewContent = "# Repo directives\nv2 from repo\n";

    writeFileSync(repoRule, repoNewContent);
    writeFileSync(liveRule, liveBeforeContent);

    const res = f.run("--deploy", "--dry-run", "--only", "enterprise-directives.md");
    assert.equal(res.status, 0, res.stderr || res.stdout);

    // Dry-run output should indicate backup and deploy preview
    assert.match(res.stdout, /backup.*enterprise-directives\.md/i);

    // Live file must remain untouched
    assert.equal(readFileSync(liveRule, "utf8"), liveBeforeContent);

    // No backup file created
    const backups = getBackups(join(f.harness, "rules"), "enterprise-directives.md");
    assert.equal(backups.length, 0, "Dry-run must not create any backup file on disk");
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("deploy backs up divergent OMP law copy before overwrite", () => {
  const f = fixture();
  try {
    mkdirSync(f.agentDir, { recursive: true });
    const ompLaw = join(f.agentDir, "AGENTS.md");
    const harnessLaw = join(f.harness, "agent", "AGENTS.md");
    const repoLaw = join(f.repo, "agent", "AGENTS.md");

    const oldLaw = "# Old user law in .omp/agent\n";
    const newLaw = "# New canonical law\n";

    writeFileSync(ompLaw, oldLaw);
    writeFileSync(harnessLaw, newLaw);
    writeFileSync(repoLaw, newLaw);

    const res = f.run("--deploy", "--only", "AGENTS.md");
    assert.equal(res.status, 0, res.stderr || res.stdout);

    // ompLaw updated
    assert.equal(readFileSync(ompLaw, "utf8"), newLaw);

    // Backup created in agentDir
    const backups = getBackups(f.agentDir, "AGENTS.md");
    assert.equal(backups.length, 1, `Expected 1 law backup, got: ${JSON.stringify(backups)}`);
    assert.equal(readFileSync(join(f.agentDir, backups[0]), "utf8"), oldLaw);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
