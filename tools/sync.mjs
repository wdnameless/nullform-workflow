#!/usr/bin/env node
/**
 * tools/sync.mjs — Sync the live OMP harness with the workflow repo (drift control).
 *
 * Single cross-platform implementation replacing twin sync.ps1 and sync.sh logic.
 *
 * defer: sync monolithic cli with live backup | ceiling: 900 lines | upgrade: split into sync-backup and sync-core modules
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp() {
  console.log(`Usage: node sync.mjs [--check|--promote|--deploy|--prune [--confirm]] [--dry-run] [--harness <dir>] [--agents-root <dir>] [--agent-dir <dir>] [--repo <dir>] [--force] [--only <substr>] [--quiet] [--json]`);
}

function parseArgs(argv) {
  const opts = {
    mode: 'check',
    prune: false,
    confirm: false,
    force: false,
    quiet: false,
    json: false,
    dryRun: false,
    only: '',
    harnessRoot: null,
    agentsRoot: '',
    agentDir: '',
    repoRoot: '',
  };

  let promoteSet = false;
  let deploySet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let key = arg;
    let val = undefined;
    if (arg.startsWith('--') && arg.includes('=')) {
      const eqIdx = arg.indexOf('=');
      key = arg.slice(0, eqIdx);
      val = arg.slice(eqIdx + 1);
    }

    switch (key) {
      case 'check':
      case '--check':
      case '-Check':
        opts.mode = 'check';
        break;
      case '--promote':
      case '-Promote':
        promoteSet = true;
        break;
      case '--deploy':
      case '-Deploy':
        deploySet = true;
        break;
      case '--prune':
      case '-Prune':
        opts.prune = true;
        break;
      case '--confirm':
      case '-Confirm':
        opts.confirm = true;
        break;
      case '--force':
      case '-Force':
        opts.force = true;
        break;
      case '--quiet':
      case '-Quiet':
        opts.quiet = true;
        break;
      case '--json':
      case '-Json':
        opts.json = true;
        break;
      case '--dry-run':
      case '-DryRun':
      case '--dryrun':
        opts.dryRun = true;
        break;
      case '--only':
      case '-Only':
        opts.only = val !== undefined ? val : argv[++i] || '';
        break;
      case '--harness':
      case '--harness-root':
      case '-HarnessRoot':
        opts.harnessRoot = val !== undefined ? val : (argv[++i] ?? '');
        break;
      case '--agents':
      case '--agents-root':
      case '-AgentsRoot':
      case '--agents-home':
        opts.agentsRoot = val !== undefined ? val : argv[++i] || '';
        break;
      case '--agent-dir':
      case '-AgentDir':
        opts.agentDir = val !== undefined ? val : argv[++i] || '';
        break;
      case '--repo':
      case '--repo-root':
      case '-RepoRoot':
        opts.repoRoot = val !== undefined ? val : argv[++i] || '';
        break;
      case '-h':
      case '--help':
      case '-Help':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(2);
    }
  }

  if (promoteSet && deploySet) {
    console.error('Choose one of --promote or --deploy.');
    process.exit(2);
  }
  if (opts.prune && (promoteSet || deploySet)) {
    console.error('Choose one of --prune, --promote or --deploy.');
    process.exit(2);
  }

  if (promoteSet) opts.mode = 'promote';
  else if (deploySet) opts.mode = 'deploy';
  else if (opts.dryRun && !opts.prune) opts.mode = 'deploy';
  return opts;
}

function resolveRepoRoot(harnessRoot, explicitRepoRoot) {
  if (explicitRepoRoot) {
    const hasInstall = fs.existsSync(path.join(explicitRepoRoot, 'install.ps1'));
    const hasModels = fs.existsSync(path.join(explicitRepoRoot, 'agent', 'models.yml.example'));
    if (hasInstall && hasModels) {
      return path.resolve(explicitRepoRoot);
    }
    const missing = [];
    if (!hasInstall) missing.push('install.ps1');
    if (!hasModels) missing.push('agent/models.yml.example');
    console.error(`Cannot locate workflow-repo at explicit path "${explicitRepoRoot}" (missing ${missing.join(', ')}).`);
    process.exit(2);
  }

  const candidates = [
    path.resolve(__dirname, '..'),
    path.resolve(harnessRoot, 'workflow-repo'),
    process.cwd(),
    path.resolve(process.cwd(), 'workflow-repo'),
  ];

  for (const c of candidates) {
    if (!c) continue;
    if (fs.existsSync(path.join(c, 'install.ps1')) && fs.existsSync(path.join(c, 'agent', 'models.yml.example'))) {
      return c;
    }
  }

  console.error("Cannot locate workflow-repo (needs install.ps1 + agent/models.yml.example). Pass -HarnessRoot or run from the repo's tools/ directory.");
  process.exit(2);
}

function readNormalized(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text.replace(/\r\n/g, '\n');
}

function writeNormalized(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text.replace(/\r\n/g, '\n'), 'utf8');
}

export const MAX_BACKUPS = 3;

let lastBackupTs = 0;
export function generateBackupTimestamp() {
  const now = Date.now();
  const effectiveNow = now <= lastBackupTs ? lastBackupTs + 1 : now;
  lastBackupTs = effectiveNow;
  return new Date(effectiveNow).toISOString().replace(/[:.]/g, '-');
}

export function getBackupsForFile(livePath) {
  const dir = path.dirname(livePath);
  if (!fs.existsSync(dir)) return [];
  const base = path.basename(livePath);
  const prefix = `${base}.bak-`;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const backups = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith(prefix)) {
        const fullPath = path.join(dir, entry.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(fullPath).mtimeMs;
        } catch {
          mtime = 0;
        }
        backups.push({ name: entry.name, fullPath, mtime });
      }
    }
    backups.sort((a, b) => (a.mtime - b.mtime) || a.name.localeCompare(b.name));
    return backups;
  } catch {
    return [];
  }
}

export function rotateBackups(livePath, maxBackups = MAX_BACKUPS) {
  const backups = getBackupsForFile(livePath);
  const deleted = [];
  if (backups.length > maxBackups) {
    const toDelete = backups.slice(0, backups.length - maxBackups);
    for (const b of toDelete) {
      try {
        fs.unlinkSync(b.fullPath);
        deleted.push(b.fullPath);
      } catch {
        // ignore deletion errors
      }
    }
  }
  return deleted;
}

export function backupLiveFile(livePath, newContent, { dryRun = false } = {}) {
  if (!fs.existsSync(livePath)) {
    return null;
  }
  const currentContent = readNormalized(livePath);
  if (currentContent === null || currentContent === newContent) {
    return null;
  }

  const ts = generateBackupTimestamp();
  const backupName = `${path.basename(livePath)}.bak-${ts}`;
  const backupPath = path.join(path.dirname(livePath), backupName);

  if (dryRun) {
    return { backupPath, backupName, dryRun: true };
  }

  const rawLive = fs.readFileSync(livePath, 'utf8');
  fs.writeFileSync(backupPath, rawLive, 'utf8');
  rotateBackups(livePath, MAX_BACKUPS);

  return { backupPath, backupName, dryRun: false };
}

function runPrune(harnessRoot, repoRoot, confirm) {
  let pruneScript = path.join(__dirname, 'sync-prune.mjs');
  if (!fs.existsSync(pruneScript)) {
    pruneScript = path.join(repoRoot, 'tools', 'sync-prune.mjs');
  }
  if (!fs.existsSync(pruneScript)) {
    console.error(`sync-prune.mjs not found. Deploy tools/sync-prune.mjs first.`);
    process.exit(2);
  }
  const pruneArgs = [pruneScript, '--harness', harnessRoot, '--repo', repoRoot];
  if (confirm) pruneArgs.push('--delete');

  const res = spawnSync(process.execPath, pruneArgs, { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`sync: prune failed (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
  if (!confirm) {
    console.log("sync: dry-run only - nothing was deleted. Re-run with '-Prune -Confirm' to delete.");
  }
  process.exit(0);
}

function isUnusableRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string' || rootPath.trim() === '') {
    return true;
  }
  const resolved = path.resolve(rootPath);
  if (!path.isAbsolute(resolved) || resolved === '.' || resolved === '..') {
    return true;
  }
  const parsed = path.parse(resolved);
  return parsed.root === resolved || parsed.base === '';
}

function normalizePath(p) {
  let resolved = path.resolve(p);
  if (resolved.startsWith('\\\\?\\')) {
    resolved = resolved.slice(4);
  }
  return resolved;
}

function isInsideOrEqual(parent, child) {
  const normParent = normalizePath(parent);
  const normChild = normalizePath(child);
  const p = process.platform === 'win32' ? normParent.toLowerCase() : normParent;
  const c = process.platform === 'win32' ? normChild.toLowerCase() : normChild;
  if (p === c) return true;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}
function resolveRealPath(p) {
  try {
    const real = fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
    return normalizePath(real);
  } catch {
    return null;
  }
}

function getCanonicalPath(targetPath) {
  let curr = path.resolve(targetPath);
  const tail = [];
  while (true) {
    let stat = null;
    try {
      stat = fs.lstatSync(curr);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    }
    if (stat !== null) {
      const real = resolveRealPath(curr);
      if (real !== null) {
        return normalizePath(path.join(real, ...tail));
      }
      if (stat.isSymbolicLink()) {
        return null;
      }
      return normalizePath(path.join(curr, ...tail));
    }
    const parent = path.dirname(curr);
    if (parent === curr) {
      return normalizePath(targetPath);
    }
    tail.unshift(path.basename(curr));
    curr = parent;
  }
}

function validatePathWithinRoot(targetPath, declaredRoot) {
  const normDeclared = normalizePath(declaredRoot);
  let declStat = null;
  try {
    declStat = fs.lstatSync(normDeclared);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      return false;
    }
  }
  if (declStat && declStat.isSymbolicLink()) {
    const realRoot = resolveRealPath(normDeclared);
    if (!realRoot) {
      return false;
    }
  }

  const canonicalRoot = getCanonicalPath(normDeclared);
  if (!canonicalRoot) return false;
  const normTarget = normalizePath(targetPath);
  const rel = path.relative(normDeclared, normTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }

  const parts = rel.split(path.sep).filter(Boolean);
  let current = normDeclared;
  let lastExistingReal = canonicalRoot;

  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        return false;
      }
    }

    if (stat !== null) {
      const real = resolveRealPath(current);
      if (real === null) {
        return false;
      }
      if (!isInsideOrEqual(canonicalRoot, real)) {
        return false;
      }
      lastExistingReal = real;
    } else {
      if (!isInsideOrEqual(canonicalRoot, lastExistingReal)) {
        return false;
      }
      const remaining = parts.slice(i);
      const plannedTarget = normalizePath(path.join(lastExistingReal, ...remaining));
      if (!isInsideOrEqual(canonicalRoot, plannedTarget)) {
        return false;
      }
      break;
    }
  }

  return true;
}

function substituteHarnessRoot(text, harnessRoot) {
  const slashHarness = harnessRoot.replace(/\\/g, '/');
  const winHarness = harnessRoot.replace(/\//g, '\\');
  const targets = Array.from(new Set([slashHarness, winHarness])).filter(Boolean);
  let res = text;
  const lb = '(?<![a-zA-Z0-9_\\-\\/\\\\])';
  const la = '(?=[\\/\\\\]|[\\r\\n \'"`\\(\\)\\[\\]\\{\\}<>:;,]|\\.(?:\\s|$)|$)';
  for (const t of targets) {
    let escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (/^[a-zA-Z]:/.test(t)) {
      const drive = t[0];
      escaped = `[${drive.toLowerCase()}${drive.toUpperCase()}]:` + escaped.slice(2);
    }
    const regex = new RegExp(lb + escaped + la, 'g');
    res = res.replace(regex, '<HARNESS>');
  }
  return res;
}


function main() { // code-size:allow
  const opts = parseArgs(process.argv.slice(2));

  const log = opts.json ? console.error : console.log;
  const rawHarnessRoot = opts.harnessRoot !== null
    ? opts.harnessRoot
    : (process.env.HARNESS_ROOT || path.join(os.homedir(), 'omp-workflow'));

  if (isUnusableRoot(rawHarnessRoot)) {
    console.error(`sync: REFUSED - harness root "${rawHarnessRoot}" is unusable (resolves to filesystem/drive root or bare path: "${path.resolve(rawHarnessRoot || '.')}"). Provide a valid harness directory path via --harness.`);
    process.exit(2);
  }

  const harnessRoot = path.resolve(rawHarnessRoot);
  const agentsRoot = path.resolve(opts.agentsRoot || process.env.AGENTS_ROOT || path.join(os.homedir(), '.agents'));
  const agentDir = path.resolve(opts.agentDir || process.env.AGENT_DIR || path.join(os.homedir(), '.omp', 'agent'));
  const repoRoot = resolveRepoRoot(harnessRoot, opts.repoRoot);


  let manifest;
  const manifestPath = path.join(__dirname, 'sync-manifest.json');
  try {
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } else {
      const repoManifest = path.join(repoRoot, 'tools', 'sync-manifest.json');
      if (fs.existsSync(repoManifest)) {
        manifest = JSON.parse(fs.readFileSync(repoManifest, 'utf8'));
      } else {
        console.error('sync-manifest.json not found.');
        process.exit(2);
      }
    }
  } catch (err) {
    console.error(`Failed to parse sync-manifest.json: ${err.message}`);
    process.exit(2);
  }

  const isApplicable = (rel) => !opts.only || rel.toLowerCase().includes(opts.only.toLowerCase());

  for (const entry of manifest) {
    if (!isApplicable(entry.rel)) continue;
    const liveRoot = entry.liveRoot === '@agents' ? agentsRoot : (entry.liveRoot === '@agentdir' ? agentDir : harnessRoot);
    const livePath = path.join(liveRoot, ...(entry.liveRel || entry.rel).split('/'));
    const repoPath = path.join(repoRoot, ...entry.rel.split('/'));

    if (!validatePathWithinRoot(livePath, liveRoot)) {
      console.error(`sync: REFUSED - live path "${livePath}" escapes declared root "${liveRoot}" or is an unresolved link`);
      process.exit(2);
    }
    if (!validatePathWithinRoot(repoPath, repoRoot)) {
      console.error(`sync: REFUSED - repo path "${repoPath}" escapes declared root "${repoRoot}" or is an unresolved link`);
      process.exit(2);
    }
  }

  const ompAgents = path.join(agentDir, 'AGENTS.md');
  const harnessAgents = path.join(harnessRoot, 'agent', 'AGENTS.md');
  const ompApplicable = !opts.only || opts.only.toLowerCase().includes('agents');
  if (ompApplicable) {
    if (!validatePathWithinRoot(ompAgents, agentDir)) {
      console.error(`sync: REFUSED - agent law path "${ompAgents}" escapes declared root "${agentDir}" or is an unresolved link`);
      process.exit(2);
    }
    if (!validatePathWithinRoot(harnessAgents, harnessRoot)) {
      console.error(`sync: REFUSED - harness law path "${harnessAgents}" escapes declared root "${harnessRoot}" or is an unresolved link`);
      process.exit(2);
    }
  }

  if (opts.prune) {
    runPrune(harnessRoot, repoRoot, opts.confirm);
  }
  const drift = [];
  const suspect = [];
  const drifted = [];
  let checked = 0;

  for (const entry of manifest) {
    const rel = entry.rel;
    if (!isApplicable(rel)) continue;
    const liveRoot = entry.liveRoot === '@agents' ? agentsRoot : (entry.liveRoot === '@agentdir' ? agentDir : harnessRoot);
    const livePath = path.join(liveRoot, ...(entry.liveRel || rel).split('/'));
    const repoPath = path.join(repoRoot, ...rel.split('/'));
    checked++;

    let live = readNormalized(livePath);
    let repo = readNormalized(repoPath);

    const isPromptSurface = rel.startsWith('agent/') || rel.startsWith('rules/') || rel.startsWith('skills/');
    let repoResolved = repo;
    if (repo !== null && isPromptSurface) {
      const slashHarness = harnessRoot.replace(/\\/g, '/');
      repoResolved = repo.replaceAll('<HARNESS>', slashHarness);
    }

    if (live === repoResolved) {
      continue;
    }

    drift.push(rel);

    if (opts.mode === 'promote') {
      if (live !== null && repo !== null) {
        const liveTime = fs.statSync(livePath).mtimeMs;
        const repoTime = fs.statSync(repoPath).mtimeMs;
        if (repoTime > liveTime) {
          suspect.push(rel);
        }
      }
    } else if (opts.mode === 'check') {
      log(`  [XX] DRIFT   ${rel}`);
    }

    drifted.push({ rel, livePath, repoPath, live, repoResolved, isPromptSurface });
  }

  if (opts.mode === 'promote') {
    if (suspect.length === 0 || opts.force) {
      const seenPromoted = new Set();
      for (const item of drifted) {
        if (item.live === null) continue;
        if (seenPromoted.has(item.repoPath)) continue;
        seenPromoted.add(item.repoPath);
        let promoteText = item.live;
        if (item.isPromptSurface) {
          promoteText = substituteHarnessRoot(promoteText, harnessRoot);
        }
        writeNormalized(item.repoPath, promoteText);
        if (!opts.quiet) {
          log(`  [->] promote ${item.rel}`);
        }
      }
    }
  } else if (opts.mode === 'deploy') {
    for (const item of drifted) {
      if (item.repoResolved === null) continue;
      const bak = backupLiveFile(item.livePath, item.repoResolved, { dryRun: opts.dryRun });
      if (bak) {
        if (!opts.quiet) {
          if (opts.dryRun) {
            log(`  [dry-run] backup ${item.rel}`);
          } else {
            log(`  [bak] backup ${item.rel}`);
          }
        }
      }
      if (!opts.dryRun) {
        writeNormalized(item.livePath, item.repoResolved);
      }
      if (!opts.quiet) {
        if (opts.dryRun) {
          log(`  [dry-run] deploy  ${item.rel}`);
        } else {
          log(`  [<-] deploy  ${item.rel}`);
        }
      }
    }
  }

  // ---------- OMP law copy parity ----------
  if (ompApplicable && fs.existsSync(harnessAgents)) {
    checked++;
    const ompText = readNormalized(ompAgents);
    const harnessText = readNormalized(harnessAgents);
    if (ompText !== harnessText) {
      if (opts.mode !== 'promote') drift.push('~/.omp/agent/AGENTS.md');
      if (opts.mode === 'deploy') {
        const bak = backupLiveFile(ompAgents, harnessText, { dryRun: opts.dryRun });
        if (bak) {
          if (!opts.quiet) {
            if (opts.dryRun) {
              log("  [dry-run] backup ~/.omp/agent/AGENTS.md");
            } else {
              log("  [bak] backup ~/.omp/agent/AGENTS.md");
            }
          }
        }
        if (!opts.dryRun) {
          writeNormalized(ompAgents, harnessText);
        }
        if (!opts.quiet) {
          if (opts.dryRun) {
            log("  [dry-run] deploy  ~/.omp/agent/AGENTS.md");
          } else {
            log("  [<-] deploy  ~/.omp/agent/AGENTS.md");
          }
        }
      } else if (opts.mode === 'promote') {
        if (!opts.quiet) log("  [--] skip    ~/.omp/agent/AGENTS.md (resolved copy; promote the harness copy instead)");
      } else {
        if (!opts.quiet) {
          log("  [XX] DRIFT   ~/.omp/agent/AGENTS.md (OMP loads this file; differs from the harness copy)");
        } else {
          log("  [XX] DRIFT   ~/.omp/agent/AGENTS.md");
        }
      }
    }
  }

  // ---------- Skills parity ----------
  const repoSkills = path.join(repoRoot, 'skills');
  const installedSkills = path.join(agentsRoot, 'skills');
  let doctorScript = path.join(__dirname, 'skills-doctor.mjs');
  if (!fs.existsSync(doctorScript)) {
    doctorScript = path.join(repoRoot, 'tools', 'skills-doctor.mjs');
  }

  const skillsApplicable = !opts.only || opts.only.toLowerCase().includes('skill') || 'skills'.includes(opts.only.toLowerCase());
  let skillsStatusText = '';
  let skillsParityStatus = 'NOT_CHECKED';
  let skillsDoctorOk = false;

  if (skillsApplicable) {
    if (fs.existsSync(doctorScript)) {
      const docRes = spawnSync(
        process.execPath,
        [doctorScript, '--installed', installedSkills, '--repo', repoSkills, '--agents-home', agentsRoot, '--json'],
        { encoding: 'utf8' }
      );
      try {
        const parsed = JSON.parse(docRes.stdout);
        skillsParityStatus = parsed.parityStatus || 'UNVERIFIED';
        skillsDoctorOk = docRes.status === 0 && parsed.ok === true && skillsParityStatus === 'VERIFIED';
        const disText = parsed.disabledCount ? `, ${parsed.disabledCount} disabled by operator` : '';
        skillsStatusText = `skills: parity ${skillsParityStatus} (${parsed.installedCount} installed, ${parsed.repoCount} in repo${disText})`;
        if (!skillsDoctorOk && opts.mode !== 'deploy' && opts.mode !== 'promote') {
          if (parsed.problems && parsed.problems.length) {
            for (const p of parsed.problems) {
              const pSkill = p.skill === '(repo)' ? 'skills' : `skills/${p.skill}`;
              if (!opts.quiet) log(`  [XX] DRIFT   ${pSkill} (${p.kind}: ${p.detail})`);
              else log(`  [XX] DRIFT   ${pSkill}`);
              drift.push(pSkill);
            }
          } else {
            drift.push('skills');
            if (!opts.quiet) log(`  [XX] DRIFT   skills (parity ${skillsParityStatus})`);
            else log('  [XX] DRIFT   skills');
          }
        }
      } catch {
        skillsParityStatus = 'UNVERIFIED';
        skillsDoctorOk = false;
        skillsStatusText = 'skills: parity UNVERIFIED (failed to parse skills-doctor output)';
        if (opts.mode !== 'deploy' && opts.mode !== 'promote') {
          drift.push('skills');
          if (!opts.quiet) log(`  [XX] DRIFT   skills (doctor parse error / exit ${docRes.status})`);
          else log('  [XX] DRIFT   skills');
        }
      }
    } else {
      skillsParityStatus = 'UNVERIFIED';
      skillsDoctorOk = false;
      skillsStatusText = 'skills: parity UNVERIFIED (skills-doctor.mjs not found)';
      if (opts.mode !== 'deploy' && opts.mode !== 'promote') {
        drift.push('skills');
        if (!opts.quiet) log('  [XX] DRIFT   skills (parity UNVERIFIED - doctor script not found)');
        else log('  [XX] DRIFT   skills');
      }
    }
  }

  if (opts.json) {
    const isOk = opts.mode === 'check'
      ? drift.length === 0
      : (opts.mode === 'promote' ? (suspect.length === 0 || opts.force) : true);
    const out = {
      ok: isOk,
      mode: opts.mode,
      clean: drift.length === 0,
      checked,
      drift,
      suspect,
      skills: {
        applicable: skillsApplicable,
        status: skillsParityStatus,
        ok: skillsDoctorOk,
        text: skillsStatusText,
      },
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(isOk ? 0 : (opts.mode === 'promote' && suspect.length && !opts.force ? 2 : 1));
  }

  if (!opts.quiet) {
    console.log('');
  }

  if (opts.mode === 'promote' || opts.mode === 'deploy') {
    if (opts.mode === 'promote' && suspect.length > 0) {
      if (!opts.force) {
        console.log(`sync: REFUSED - ${suspect.length} repo file(s) are NEWER than the live tree:`);
        for (const x of suspect) console.log(`  ${x}`);
        console.log('');
        console.log('Promoting would overwrite that work with a stale harness. Either:');
        console.log('  -Deploy      push the repo (newer) INTO the live tree, or');
        console.log('  -Promote -Force   if the live tree really is the intended source');
        process.exit(2);
      } else {
        console.log(`sync: FORCED - overwrote ${suspect.length} newer repo file(s) with the live tree:`);
        for (const x of suspect) console.log(`  ${x}`);
      }
    }

    const action = opts.mode === 'promote'
      ? (opts.dryRun ? 'would be promoted to repo (dry-run)' : 'promoted to repo')
      : (opts.dryRun ? 'would be deployed to harness (dry-run)' : 'deployed to harness');
    if (opts.mode === 'deploy' && skillsApplicable && skillsStatusText) {
      console.log(skillsStatusText);
      if (skillsParityStatus !== 'VERIFIED') {
        console.log(`sync: file deployment complete; skill parity ${skillsParityStatus} (${drift.length}/${checked} files ${action})`);
        process.exit(0);
      }
    }
    console.log(`sync: ${drift.length}/${checked} files ${action}`);
    process.exit(0);
  }

  if (drift.length === 0) {
    if (skillsStatusText && !opts.quiet) {
      console.log(skillsStatusText);
    }
    const extraClean = (skillsApplicable && skillsDoctorOk) ? ', skills parity verified' : '';
    console.log(`sync: clean (${checked} files checked${extraClean})`);
    process.exit(0);
  }

  if (skillsStatusText && !opts.quiet) {
    console.log(skillsStatusText);
  }
  console.log(`sync: ${drift.length}/${checked} items drifted. Run -Promote or -Deploy.`);
  process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  main();
}
