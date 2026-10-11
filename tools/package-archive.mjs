import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve, join, dirname, basename, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isStructuralExcludedPath, isAcceptancePath, hashFile } from "./worktree-snapshot.mjs";

export const TEXT_PATH = /(?:\.(?:md|mdc|mjs|cjs|js|jsx|ts|tsx|py|json|jsonc|json5|jsonl|ya?ml|toml|txt|ps1|psm1|sh|bash|css|html|xml|svg|csv|srt|example)|(?:^|\/)(?:VERSION|LICENSE|Dockerfile|Makefile|\.gitattributes|\.gitignore))$/i;
const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");
export const ALL_8_HARNESSES = ["claude", "codex", "opencode", "cursor", "omp", "openclaw", "hermes", "openhuman"];

export const REQUIRED_MATRIX_CELLS = [
  { platform: "linux", arch: "x64", nodeMajor: 22 },
  { platform: "linux", arch: "x64", nodeMajor: 24 },
  { platform: "win32", arch: "x64", nodeMajor: 22 },
  { platform: "win32", arch: "x64", nodeMajor: 24 },
  { platform: "darwin", arch: "x64", altArch: "arm64", nodeMajor: 22 },
  { platform: "darwin", arch: "x64", altArch: "arm64", nodeMajor: 24 },
];

export function buildHarnessFixture(harness, root, home, proj, secret) {
  const hb = `Preserve human top note for ${harness} verbatim.`;
  const ha = `Preserve human bottom note for ${harness} verbatim.`;
  const stdMd = `# User Heading (${harness})\n\n${hb}\n\n<!-- BEGIN NULLFORM WORKFLOW -->\nOld workflow block to replace cleanly.\n<!-- END NULLFORM WORKFLOW -->\n\n${ha}\n`;
  const opencodeJsonc = `{\n  // User JSONC comment preserved at trust boundary\n  "$schema": "https://opencode.ai/config.json",\n  "share": "manual",\n  "provider": { "openai": { "options": { "apiKey": "${secret}", }, }, },\n}\n`;
  const openclawJson5 = `{\n  // OpenClaw JSON5 user configuration\n  env: { vars: { OPENAI_API_KEY: '${secret}', }, },\n  agents: { entries: { customAgent: { workspace: '/tmp/custom-agent', }, }, },\n}\n`;
  const hermesYaml = `# User Hermes YAML config\nmodel: "anthropic/claude-3-5-sonnet"\napi_key: "${secret} # hash inside quoted YAML string"\ncustom_multiline: |\n  first line # keep comment char in literal block\n  second line\ndefaults: &default_settings\n  timeout: 45\nservice:\n  <<: *default_settings\nmcp_servers:\n  customUserServer:\n    command: "node"\n    args: ["custom-server.js"]\n    env:\n      API_TOKEN: "${secret}"\n`;
  const ompMcp = JSON.stringify({ mcpServers: { customUserMcp: { command: "node", args: ["mcp.js"], env: { TOKEN: secret } } } }, null, 2) + "\n";
  const openhumanToml = `# User OpenHuman TOML config\n[agent]\nagents_md_enabled = true\n\n[env]\nOPENAI_API_KEY = "${secret}"\n`;
  const cursorMdc = `---\ndescription: Custom User Cursor Rule\nalwaysApply: true\n---\n\n${hb}\n\n<!-- BEGIN NULLFORM WORKFLOW -->\nOld workflow block to replace cleanly.\n<!-- END NULLFORM WORKFLOW -->\n\n${ha}\n`;

  const map = {
    claude: { md: [join(root, "CLAUDE.md"), join(home, ".claude", "CLAUDE.md")], skills: join(home, ".claude", "skills") },
    codex: { md: [join(root, "AGENTS.md"), join(home, ".codex", "AGENTS.md")], skills: join(home, ".codex", "skills") },
    opencode: { md: [join(root, "AGENTS.md"), join(home, ".config", "opencode", "AGENTS.md")], cfg: [join(root, "opencode.json"), join(home, ".config", "opencode", "opencode.json")], cfgBody: opencodeJsonc, cfgKind: "jsonc", skills: join(home, ".config", "opencode", "skills") },
    cursor: { md: [join(proj, ".cursor", "rules", "00-workflow.mdc")], mdBody: cursorMdc, skills: join(root, "skills") },
    omp: { md: [join(home, ".omp", "agent", "AGENTS.md")], cfg: [join(home, ".omp", "agent", "mcp.json")], cfgBody: ompMcp, cfgKind: "omp-json", skills: join(home, ".agents", "skills") },
    openclaw: { md: [join(root, "AGENTS.md"), join(root, "SOUL.md"), join(root, "USER.md")], cfg: [join(root, "openclaw.json"), join(home, ".openclaw", "openclaw.json")], cfgBody: openclawJson5, cfgKind: "json5", skills: join(home, ".openclaw", "skills") },
    hermes: { md: [join(root, "AGENTS.md"), join(home, ".hermes", "SOUL.md"), join(home, ".hermes", "AGENTS.md")], cfg: [join(root, "config.yaml"), join(home, ".hermes", "config.yaml")], cfgBody: hermesYaml, cfgKind: "yaml", skills: join(home, ".hermes", "skills") },
    openhuman: { md: [join(root, "AGENTS.md"), join(home, ".openhuman", "AGENTS.md")], cfg: [join(home, ".openhuman", "config.toml")], cfgBody: openhumanToml, cfgKind: "toml", skills: join(home, ".openhuman", "skills"), noSymlink: true },
  };
  const e = map[harness];
  return { mdFiles: e.md, mdContent: e.mdBody || stdMd, cfgFiles: e.cfg || [], cfgContent: e.cfgBody, cfgKind: e.cfgKind, skillsDir: e.skills, noSymlinkSkills: e.noSymlink, humanBefore: hb, humanAfter: ha };
}

export function seedHarnessFiles(fixture, customRoot, secretToken) {
  writeFileSync(join(customRoot, "unrelated-notes.txt"), "Unrelated user file content.\n", "utf8");
  writeFileSync(join(customRoot, ".env"), `USER_ENV_SECRET=${secretToken}\n`, "utf8");
  for (const mdPath of fixture.mdFiles) {
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, fixture.mdContent, "utf8");
  }
  for (const cfgPath of fixture.cfgFiles) {
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, fixture.cfgContent, "utf8");
  }
}

export function computeFileDigests(filePath) {
  const buf = readFileSync(filePath);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const sha512 = createHash("sha512").update(buf).digest("hex");
  return { sha256, sha512, size: buf.length };
}

export function deriveHigherVersion(version, step = 1) {
  const parts = String(version).trim().split(".").map(Number);
  if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
    parts[1] += step;
    parts[2] = 0;
    return parts.join(".");
  }
  return `${version}-upgrade.${step}`;
}

export function verifyChecksumFile(checksumFilePath, targetDir) {
  const content = readFileSync(checksumFilePath, "utf8").trim();
  const [expectedHash, ...nameParts] = content.split(/\s+/);
  const filename = nameParts.join(" ").replace(/^\*/, "");
  const targetPath = join(targetDir, filename);
  assert.ok(existsSync(targetPath), `Target file ${filename} missing for checksum verification`);
  const digests = computeFileDigests(targetPath);
  const actualHash = expectedHash.length === 128 ? digests.sha512 : digests.sha256;
  assert.equal(actualHash.toLowerCase(), expectedHash.toLowerCase(), `Checksum mismatch for ${filename}`);
  return true;
}

export function resolveNpmInvocation(env = process.env) {
  const execDir = dirname(process.execPath);
  const candidates = [
    env.npm_execpath,
    join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(execDir, "node_modules", "npm", "index.js"),
    ...(env.PATH || "").split(delimiter).filter(Boolean).flatMap((d) => [
      join(d, "node_modules", "npm", "bin", "npm-cli.js"),
      join(d, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ]),
  ];
  for (const c of candidates) {
    if (c && /\.[cm]?js$/i.test(c) && existsSync(c)) {
      return { command: process.execPath, prefixArgs: [c], shell: false };
    }
  }
  if (process.platform === "win32") {
    const winCandidates = [
      join(execDir, "npm.cmd"),
      ...(env.PATH || "").split(delimiter).filter(Boolean).map((d) => join(d, "npm.cmd")),
    ];
    for (const p of winCandidates) {
      if (p && existsSync(p)) return { command: p, prefixArgs: [], shell: true };
    }
    return { command: env.ComSpec || "cmd.exe", prefixArgs: ["/d", "/s", "/c", "npm"], shell: false };
  }
  return { command: "npm", prefixArgs: [], shell: false };
}

export function safeExtractArchive(tarballPath, targetDir, options = {}) {
  mkdirSync(targetDir, { recursive: true });
  const listRes = spawnSync("tar", ["-tf", tarballPath], { encoding: "utf8", windowsHide: true });
  assert.equal(listRes.status, 0, `tar -tf failed: ${listRes.stderr || listRes.stdout}`);
  const entries = listRes.stdout.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    const norm = entry.replace(/\\/g, "/");
    assert.ok(!norm.startsWith("/") && !norm.startsWith("\\"), `Absolute entry rejected: ${norm}`);
    assert.ok(!norm.includes("../") && !norm.startsWith(".."), `Traversal entry rejected: ${norm}`);
    if (options.requirePackagePrefix !== false) {
      assert.ok(norm === "package" || norm.startsWith("package/"), `Entry not under package/: ${norm}`);
    }
  }
  const extractRes = spawnSync("tar", ["-xzf", tarballPath, "-C", targetDir], { encoding: "utf8", windowsHide: true });
  assert.equal(extractRes.status, 0, `tar -xzf failed: ${extractRes.stderr || extractRes.stdout}`);
  return entries;
}

export function inspectArchiveContents(tarballPath, tempBase = null, options = {}) {
  const base = tempBase || mkdtempSync(join(tmpdir(), "inspect-archive-"));
  const unpackDir = join(base, "unpack");
  try {
    const entries = safeExtractArchive(tarballPath, unpackDir, { requirePackagePrefix: true });
    const pkgDir = join(unpackDir, "package");
    assert.ok(existsSync(join(pkgDir, "package.json")), "package.json missing from archive");
    const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const versionFile = existsSync(join(pkgDir, "VERSION"))
      ? readFileSync(join(pkgDir, "VERSION"), "utf8").trim()
      : null;

    assert.equal(pkgJson.name, "nullform-workflow", "package.json name must be nullform-workflow");
    assert.equal(pkgJson.bin?.nullform, "bin/nullform.mjs", "bin.nullform must point to bin/nullform.mjs");
    assert.equal(versionFile, pkgJson.version, "Archive VERSION must match package.json version");

    const pinnedDeps = { json5: "2.2.3", "jsonc-parser": "3.3.1", yaml: "2.9.1" };
    for (const [dep, ver] of Object.entries(pinnedDeps)) {
      assert.equal(pkgJson.dependencies?.[dep], ver, `Dependency ${dep} must be pinned to ${ver}`);
    }

    const bannedScripts = ["preinstall", "install", "postinstall", "prepublish", "prepare"];
    for (const s of bannedScripts) {
      assert.ok(!pkgJson.scripts?.[s], `Lifecycle script ${s} must not exist`);
    }
    const packedFiles = entries
      .map((e) => e.replace(/\\/g, "/"))
      .filter((e) => e !== "package" && e !== "package/" && e.startsWith("package/"))
      .map((e) => e.slice("package/".length))
      .filter((rel) => {
        if (!rel || rel.endsWith("/")) return false;
        const full = join(pkgDir, rel);
        try {
          return statSync(full).isFile();
        } catch {
          return false;
        }
      });
    const bannedPrefixes = [
      ".tmp", ".workflow", "bench/runs", "history", "openspec", "tools/tests",
      "tools/npm-smoke.mjs", "tools/certify-package.mjs", "tools/publish-release.mjs", "tools/package-archive.mjs",
      ".git", "node_modules", "agent/config.yml", "agent/models.yml", "agent/mcp.json",
    ];
    for (const f of packedFiles) {
      for (const b of bannedPrefixes) {
        assert.ok(f !== b && !f.startsWith(`${b}/`) && !f.includes("/node_modules/"), `Banned asset in archive: ${f}`);
      }
      assert.ok(!f.endsWith("CODEMAP.md") && !(/\.env(\.|$)/i.test(f) && !f.endsWith("secrets.example.env")), `Forbidden file in archive: ${f}`);
    }
    const requiredFiles = [
      "package.json", "VERSION", "LICENSE", "jev/LICENSE", "README.md", "CONTEXT.md",
      ".code-size.baseline.json", "bin/nullform.mjs", "tools/install-harness.mjs", "tools/harness-config.mjs",
      "tools/installation-state.mjs", "tools/doctor.mjs", "tools/self-update.mjs", "tools/workflow.mjs",
      "tools/verify.mjs", "tools/sync-manifest.json", "verify.ps1", "verify.sh",
    ];
    for (const req of requiredFiles) {
      assert.ok(packedFiles.includes(req), `Required asset missing from archive: ${req}`);
    }
    if (options.repoRoot) {
      const repoRoot = options.repoRoot;
      const repoPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
      const repoVer = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
      assert.equal(pkgJson.name, repoPkg.name, `Archive name (${pkgJson.name}) mismatch with repo (${repoPkg.name})`);
      assert.equal(pkgJson.version, repoVer, `Archive version (${pkgJson.version}) mismatch with repo VERSION (${repoVer})`);
      assert.equal(pkgJson.version, repoPkg.version, `Archive version (${pkgJson.version}) mismatch with repo package.json (${repoPkg.version})`);

      for (const rel of packedFiles) {
        const archiveFilePath = join(pkgDir, rel);
        const repoFilePath = join(repoRoot, rel);
        assert.ok(existsSync(repoFilePath), `Unowned extra file in archive not present in repository: ${rel}`);
        const isText = TEXT_PATH.test(rel);
        const archiveHash = hashFile(archiveFilePath, isText);
        const repoHash = hashFile(repoFilePath, isText);
        assert.ok(archiveHash, `Failed to hash archive file ${rel}`);
        assert.ok(repoHash, `Failed to hash repository file ${rel}`);
        assert.equal(archiveHash, repoHash, `Archive file ${rel} byte/hash mismatch with current repository source`);
      }
    }

    return { pkgJson, version: pkgJson.version, pkgDir, packedFiles };
  } finally {
    if (!tempBase && existsSync(base)) {
      try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
    }
  }
}

export function getGitCommit(root = REPO_ROOT) {
  try {
    const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
    if (res.status === 0 && /^[0-9a-f]{40}$/i.test(res.stdout.trim())) return res.stdout.trim();
  } catch {}
  throw new Error("Unable to determine current verified git commit from repository");
}

export function assertCleanWorkingTree(root = REPO_ROOT) {
  let res;
  try {
    res = spawnSync("git", ["status", "--porcelain=v1", "-z", "-uall"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (err) {
    throw new Error(`Working tree cleanliness verification failed: ${err.message}`);
  }
  if (!res || res.status !== 0) {
    throw new Error(`git status failed with exit code ${res?.status}: ${res?.stderr || "unknown git error"}`);
  }
  const raw = res.stdout || "";
  const entries = raw.split("\0").filter(Boolean);
  const dirty = [];
  for (const entry of entries) {
    const status = entry.slice(0, 2);
    const path = entry.slice(3).trim();
    if (!path) continue;
    if (status !== "??" && status !== "!!") {
      dirty.push(`${status} ${path}`);
      continue;
    }
    const norm = path.replace(/\\/g, "/");
    if (isStructuralExcludedPath(norm) || isAcceptancePath(norm)) {
      continue;
    }
    dirty.push(`?? ${norm}`);
  }
  if (dirty.length > 0) {
    throw new Error(`Working tree has uncommitted modifications: ${dirty.slice(0, 5).join(", ")}`);
  }
  return true;
}

export function getNpmVersion(root = REPO_ROOT, env = process.env) {
  try {
    const inv = resolveNpmInvocation(env);
    const res = spawnSync(inv.command, [...inv.prefixArgs, "--version"], {
      cwd: root,
      encoding: "utf8",
      shell: inv.shell || false,
      windowsHide: true,
    });
    if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  } catch {}
  throw new Error("Unable to determine current npm version via verified npm invocation");
}

export function loadCertificates(certsOption) {
  if (!certsOption) return [];
  if (Array.isArray(certsOption)) return certsOption;
  if (typeof certsOption === "object") return [certsOption];

  const targetPath = resolve(certsOption);
  if (!existsSync(targetPath)) return [];
  const stat = statSync(targetPath);
  if (stat.isDirectory()) {
    const certs = [];
    const readDirRecursive = (dir) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, f.name);
        if (f.isDirectory()) readDirRecursive(full);
        else if (f.name.endsWith(".json")) {
          try {
            const content = JSON.parse(readFileSync(full, "utf8"));
            certs.push({ ...content, _sourceFile: f.name });
          } catch {}
        }
      }
    };
    readDirRecursive(targetPath);
    return certs;
  }
  try {
    const content = JSON.parse(readFileSync(targetPath, "utf8"));
    return [{ ...content, _sourceFile: basename(targetPath) }];
  } catch {
    return [];
  }
}
