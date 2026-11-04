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
import { validatePathWithinScope } from './worktree-snapshot.mjs';
import {
  MANAGED_START,
  MANAGED_END,
  preflightManagedMarkers,
  applyManagedSection,
  extractManagedSection,
} from './installation/config.mjs';

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
  if (!rootPath || typeof rootPath !== 'string' || rootPath.trim() === '') return true;
  const resolved = path.resolve(rootPath);
  if (!path.isAbsolute(resolved) || resolved === '.' || resolved === '..') return true;
  const parsed = path.parse(resolved);
  return parsed.root === resolved || parsed.base === '';
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

function resolveLiveRoot(liveRootName, agentsRoot, agentDir, harnessRoot) {
  if (liveRootName === '@agents') return agentsRoot;
  if (liveRootName === '@agentdir') return agentDir;
  return harnessRoot;
}

function loadSyncManifest(repoRoot) {
  const manifestPath = path.join(__dirname, 'sync-manifest.json');
  try {
    if (fs.existsSync(manifestPath)) return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const repoManifest = path.join(repoRoot, 'tools', 'sync-manifest.json');
    if (fs.existsSync(repoManifest)) return JSON.parse(fs.readFileSync(repoManifest, 'utf8'));
    console.error('sync-manifest.json not found.');
    process.exit(2);
  } catch (err) {
    console.error(`Failed to parse sync-manifest.json: ${err.message}`);
    process.exit(2);
  }
}

function preflightSyncPaths(manifest, isApplicable, harnessRoot, repoRoot, agentsRoot, agentDir, ompAgents, harnessAgents, repoAgents, ompApplicable) {
  for (const entry of manifest) {
    if (!isApplicable(entry.rel)) continue;
    const liveRoot = resolveLiveRoot(entry.liveRoot, agentsRoot, agentDir, harnessRoot);
    const livePath = path.join(liveRoot, ...(entry.liveRel || entry.rel).split('/'));
    const repoPath = path.join(repoRoot, ...entry.rel.split('/'));
    if (!validatePathWithinScope(livePath, liveRoot, null, true)) {
      console.error(`sync: REFUSED - live path "${livePath}" escapes declared root "${liveRoot}" or is an unresolved link`);
      process.exit(2);
    }
    if (!validatePathWithinScope(repoPath, repoRoot, null, true)) {
      console.error(`sync: REFUSED - repo path "${repoPath}" escapes declared root "${repoRoot}" or is an unresolved link`);
      process.exit(2);
    }
  }

  if (ompApplicable) {
    if (!validatePathWithinScope(ompAgents, agentDir, null, true)) {
      console.error(`sync: REFUSED - agent law path "${ompAgents}" escapes declared root "${agentDir}" or is an unresolved link`);
      process.exit(2);
    }
    if (!validatePathWithinScope(harnessAgents, harnessRoot, null, true)) {
      console.error(`sync: REFUSED - harness law path "${harnessAgents}" escapes declared root "${harnessRoot}" or is an unresolved link`);
      process.exit(2);
    }
    if (fs.existsSync(repoAgents) && !validatePathWithinScope(repoAgents, repoRoot, null, true)) {
      console.error(`sync: REFUSED - repo law path "${repoAgents}" escapes declared root "${repoRoot}" or is an unresolved link`);
      process.exit(2);
    }
  }
}

function checkEntryDrift(entry, context) {
  const { agentsRoot, agentDir, harnessRoot, repoRoot, opts, log, suspect } = context;
  const rel = entry.rel;
  const liveRoot = resolveLiveRoot(entry.liveRoot, agentsRoot, agentDir, harnessRoot);
  const livePath = path.join(liveRoot, ...(entry.liveRel || rel).split('/'));
  const repoPath = path.join(repoRoot, ...rel.split('/'));

  const live = readNormalized(livePath);
  const repo = readNormalized(repoPath);
  const isOptionalOverlay = entry.liveRoot === '@agentdir' || entry.liveRoot === '@agents';
  if (opts.mode === 'check' && live === null && isOptionalOverlay) return null;

  const isPromptSurface = rel.startsWith('agent/') || rel.startsWith('rules/') || rel.startsWith('skills/');
  let repoResolved = repo;
  if (repo !== null && isPromptSurface) {
    repoResolved = repo.replaceAll('<HARNESS>', harnessRoot.replace(/\\/g, '/'));
  }
  if (live === repoResolved) return null;

  if (opts.mode === 'promote') {
    if (live !== null && repo !== null) {
      if (fs.statSync(repoPath).mtimeMs > fs.statSync(livePath).mtimeMs) suspect.push(rel);
    }
  } else if (opts.mode === 'check') {
    log(`  [XX] DRIFT   ${rel}`);
  }
  return { rel, livePath, repoPath, live, repoResolved, isPromptSurface };
}

function applyPromote(drifted, suspect, harnessRoot, opts, log) {
  if (suspect.length > 0 && !opts.force) return;
  const seenPromoted = new Set();
  for (const item of drifted) {
    if (item.live === null || seenPromoted.has(item.repoPath)) continue;
    seenPromoted.add(item.repoPath);
    let promoteText = item.live;
    if (item.isPromptSurface) {
      promoteText = substituteHarnessRoot(promoteText, harnessRoot);
    }
    writeNormalized(item.repoPath, promoteText);
    if (!opts.quiet) log(`  [->] promote ${item.rel}`);
  }
}

function deployOneItem(item, opts, log) {
  if (item.repoResolved === null) return;
  const bak = backupLiveFile(item.livePath, item.repoResolved, { dryRun: opts.dryRun });
  if (bak && !opts.quiet) {
    log(opts.dryRun ? `  [dry-run] backup ${item.rel}` : `  [bak] backup ${item.rel}`);
  }
  if (!opts.dryRun) writeNormalized(item.livePath, item.repoResolved);
  if (!opts.quiet) {
    log(opts.dryRun ? `  [dry-run] deploy  ${item.rel}` : `  [<-] deploy  ${item.rel}`);
  }
}

function applyDeploy(drifted, opts, log) {
  for (const item of drifted) deployOneItem(item, opts, log);
}

function evaluateOmpLawDrift(ompText, harnessText, canonicalLaw, ompAgents, harnessAgents, repoAgents) {
  if (ompText === null) return { isDrift: true, malformedError: null };
  const hasStart = ompText.includes(MANAGED_START);
  const hasEnd = ompText.includes(MANAGED_END);
  if (!hasStart && !hasEnd) {
    const isDrift = (ompText !== harnessText) || (canonicalLaw !== null && ompText !== canonicalLaw);
    return { isDrift, malformedError: null };
  }
  try {
    preflightManagedMarkers(ompAgents, ompText);
    const ompManaged = extractManagedSection(ompText, ompAgents);
    const harnessManaged = extractManagedSection(harnessText, harnessAgents) ?? harnessText.trim();
    const canonicalManaged = canonicalLaw !== null
      ? (extractManagedSection(canonicalLaw, repoAgents) ?? canonicalLaw.trim())
      : harnessManaged;
    const isDrift = (ompManaged !== harnessManaged) || (ompManaged !== canonicalManaged);
    return { isDrift, malformedError: null };
  } catch (err) {
    return { isDrift: true, malformedError: err.message };
  }
}

function deployOmpLaw(ompAgents, targetContent, opts, log) {
  const bak = backupLiveFile(ompAgents, targetContent, { dryRun: opts.dryRun });
  if (bak && !opts.quiet) {
    log(opts.dryRun ? "  [dry-run] backup ~/.omp/agent/AGENTS.md" : "  [bak] backup ~/.omp/agent/AGENTS.md");
  }
  if (!opts.dryRun) writeNormalized(ompAgents, targetContent);
  if (!opts.quiet) {
    log(opts.dryRun ? "  [dry-run] deploy  ~/.omp/agent/AGENTS.md" : "  [<-] deploy  ~/.omp/agent/AGENTS.md");
  }
}

function reportOmpLawDrift(opts, log, malformedError) {
  if (!opts.quiet) {
    if (malformedError) log(`  [XX] DRIFT   ~/.omp/agent/AGENTS.md (malformed managed markers: ${malformedError})`);
    else log("  [XX] DRIFT   ~/.omp/agent/AGENTS.md (OMP loads this file; differs from the harness copy)");
  } else {
    log("  [XX] DRIFT   ~/.omp/agent/AGENTS.md");
  }
}

function handleOmpLawDrift({ opts, log, drift, malformedError, canonicalLaw, harnessText, harnessAgents, ompAgents, ompText }) {
  if (opts.mode !== 'promote') drift.push('~/.omp/agent/AGENTS.md');
  if (opts.mode === 'deploy') {
    if (malformedError) {
      console.error(`sync: REFUSED - cannot deploy to ~/.omp/agent/AGENTS.md: ${malformedError}`);
      process.exit(2);
    }
    const lawSource = canonicalLaw ?? harnessText;
    const sourceManaged = extractManagedSection(lawSource, harnessAgents) ?? lawSource.trim();
    let target = lawSource;
    if (ompText !== null && (ompText.includes(MANAGED_START) || ompText.includes(MANAGED_END))) {
      target = applyManagedSection(ompText, sourceManaged);
    }
    deployOmpLaw(ompAgents, target, opts, log);
  } else if (opts.mode === 'promote') {
    if (!opts.quiet) log("  [--] skip    ~/.omp/agent/AGENTS.md (resolved copy; promote the harness copy instead)");
  } else {
    reportOmpLawDrift(opts, log, malformedError);
  }
}

function reportSkillProblems(problems, status, opts, log, drift) {
  if (problems && problems.length) {
    for (const p of problems) {
      const pSkill = p.skill === '(repo)' ? 'skills' : `skills/${p.skill}`;
      log(opts.quiet ? `  [XX] DRIFT   ${pSkill}` : `  [XX] DRIFT   ${pSkill} (${p.kind}: ${p.detail})`);
      drift.push(pSkill);
    }
  } else {
    drift.push('skills');
    log(opts.quiet ? '  [XX] DRIFT   skills' : `  [XX] DRIFT   skills (parity ${status})`);
  }
}

function checkDoctorParity(doctorScript, installedSkills, repoSkills, agentsRoot, opts, log, drift) {
  const docRes = spawnSync(
    process.execPath,
    [doctorScript, '--installed', installedSkills, '--repo', repoSkills, '--agents-home', agentsRoot, '--json'],
    { encoding: 'utf8' }
  );
  try {
    const parsed = JSON.parse(docRes.stdout);
    const status = parsed.parityStatus || 'UNVERIFIED';
    const ok = docRes.status === 0 && parsed.ok === true && status === 'VERIFIED';
    const disText = parsed.disabledCount ? `, ${parsed.disabledCount} disabled by operator` : '';
    const text = `skills: parity ${status} (${parsed.installedCount} installed, ${parsed.repoCount} in repo${disText})`;
    if (!ok && opts.mode !== 'deploy' && opts.mode !== 'promote') {
      reportSkillProblems(parsed.problems, status, opts, log, drift);
    }
    return { status, ok, text };
  } catch {
    const text = 'skills: parity UNVERIFIED (failed to parse skills-doctor output)';
    if (opts.mode !== 'deploy' && opts.mode !== 'promote') {
      drift.push('skills');
      log(opts.quiet ? '  [XX] DRIFT   skills' : `  [XX] DRIFT   skills (doctor parse error / exit ${docRes.status})`);
    }
    return { status: 'UNVERIFIED', ok: false, text };
  }
}

function checkPromoteSuspects(suspect, force) {
  if (suspect.length === 0) return;
  if (!force) {
    console.log(`sync: REFUSED - ${suspect.length} repo file(s) are NEWER than the live tree:`);
    for (const x of suspect) console.log(`  ${x}`);
    console.log('\nPromoting would overwrite that work with a stale harness. Either:');
    console.log('  -Deploy      push the repo (newer) INTO the live tree, or');
    console.log('  -Promote -Force   if the live tree really is the intended source');
    process.exit(2);
  }
  console.log(`sync: FORCED - overwrote ${suspect.length} newer repo file(s) with the live tree:`);
  for (const x of suspect) console.log(`  ${x}`);
}

function finishSyncCli(opts, drift, suspect, checked, skillsInfo) {
  if (opts.mode === 'promote') {
    checkPromoteSuspects(suspect, opts.force);
  }
  const action = opts.mode === 'promote'
    ? (opts.dryRun ? 'would be promoted to repo (dry-run)' : 'promoted to repo')
    : (opts.dryRun ? 'would be deployed to harness (dry-run)' : 'deployed to harness');

  if (opts.mode === 'deploy' && skillsInfo.applicable && skillsInfo.text) {
    console.log(skillsInfo.text);
    if (skillsInfo.status !== 'VERIFIED') {
      console.log(`sync: file deployment complete; skill parity ${skillsInfo.status} (${drift.length}/${checked} files ${action})`);
      process.exit(0);
    }
  }
  console.log(`sync: ${drift.length}/${checked} files ${action}`);
  process.exit(0);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = opts.json ? console.error : console.log;
  const rawHarnessRoot = opts.harnessRoot !== null ? opts.harnessRoot : (process.env.HARNESS_ROOT || path.join(os.homedir(), 'omp-workflow'));

  if (isUnusableRoot(rawHarnessRoot)) {
    console.error(`sync: REFUSED - harness root "${rawHarnessRoot}" is unusable (resolves to filesystem/drive root or bare path: "${path.resolve(rawHarnessRoot || '.')}"). Provide a valid harness directory path via --harness.`);
    process.exit(2);
  }

  const harnessRoot = path.resolve(rawHarnessRoot);
  const agentsRoot = path.resolve(opts.agentsRoot || process.env.AGENTS_ROOT || path.join(os.homedir(), '.agents'));
  const agentDir = path.resolve(opts.agentDir || process.env.AGENT_DIR || path.join(os.homedir(), '.omp', 'agent'));
  const repoRoot = resolveRepoRoot(harnessRoot, opts.repoRoot);

  const manifest = loadSyncManifest(repoRoot);
  const isApplicable = (rel) => !opts.only || rel.toLowerCase().includes(opts.only.toLowerCase());

  const ompAgents = path.join(agentDir, 'AGENTS.md');
  const harnessAgents = path.join(harnessRoot, 'agent', 'AGENTS.md');
  const repoAgents = path.join(repoRoot, 'agent', 'AGENTS.md');
  const ompApplicable = !opts.only || opts.only.toLowerCase().includes('agents');

  preflightSyncPaths(manifest, isApplicable, harnessRoot, repoRoot, agentsRoot, agentDir, ompAgents, harnessAgents, repoAgents, ompApplicable);

  if (opts.prune) runPrune(harnessRoot, repoRoot, opts.confirm);

  const drift = [];
  const suspect = [];
  const drifted = [];
  let checked = 0;

  for (const entry of manifest) {
    if (!isApplicable(entry.rel)) continue;
    checked++;
    const item = checkEntryDrift(entry, { agentsRoot, agentDir, harnessRoot, repoRoot, opts, log, suspect });
    if (item) {
      drift.push(item.rel);
      drifted.push(item);
    }
  }

  if (opts.mode === 'promote') applyPromote(drifted, suspect, harnessRoot, opts, log);
  else if (opts.mode === 'deploy') applyDeploy(drifted, opts, log);

  // ---------- OMP law copy parity ----------
  if (ompApplicable && fs.existsSync(harnessAgents)) {
    checked++;
    const ompText = readNormalized(ompAgents);
    const harnessText = readNormalized(harnessAgents);
    const slashHarness = harnessRoot.replace(/\\/g, '/');
    const repoLawText = fs.existsSync(repoAgents) ? readNormalized(repoAgents) : null;
    const canonicalLaw = repoLawText !== null ? repoLawText.replaceAll('<HARNESS>', slashHarness) : harnessText;

    const { isDrift, malformedError } = evaluateOmpLawDrift(ompText, harnessText, canonicalLaw, ompAgents, harnessAgents, repoAgents);
    if (isDrift) {
      handleOmpLawDrift({ opts, log, drift, malformedError, canonicalLaw, harnessText, harnessAgents, ompAgents, ompText });
    }
  }

  // ---------- Skills parity ----------
  const repoSkills = path.join(repoRoot, 'skills');
  const installedSkills = path.join(agentsRoot, 'skills');
  let doctorScript = path.join(__dirname, 'skills-doctor.mjs');
  if (!fs.existsSync(doctorScript)) doctorScript = path.join(repoRoot, 'tools', 'skills-doctor.mjs');

  const skillsApplicable = !opts.only || opts.only.toLowerCase().includes('skill') || 'skills'.includes(opts.only.toLowerCase());
  let skillsStatusText = '';
  let skillsParityStatus = 'NOT_CHECKED';
  let skillsDoctorOk = false;

  if (skillsApplicable && !fs.existsSync(installedSkills)) {
    skillsParityStatus = 'NOT_APPLICABLE';
    skillsStatusText = `skills: n/a (no global catalogue at ${installedSkills})`;
  } else if (skillsApplicable && fs.existsSync(doctorScript)) {
    const res = checkDoctorParity(doctorScript, installedSkills, repoSkills, agentsRoot, opts, log, drift);
    skillsParityStatus = res.status;
    skillsDoctorOk = res.ok;
    skillsStatusText = res.text;
  } else if (skillsApplicable) {
    skillsParityStatus = 'UNVERIFIED';
    skillsStatusText = 'skills: parity UNVERIFIED (skills-doctor.mjs not found)';
    if (opts.mode !== 'deploy' && opts.mode !== 'promote') {
      drift.push('skills');
      log(opts.quiet ? '  [XX] DRIFT   skills' : '  [XX] DRIFT   skills (parity UNVERIFIED - doctor script not found)');
    }
  }

  if (opts.json) {
    const isOk = opts.mode === 'check' ? drift.length === 0 : (opts.mode === 'promote' ? (suspect.length === 0 || opts.force) : true);
    console.log(JSON.stringify({
      ok: isOk,
      mode: opts.mode,
      clean: drift.length === 0,
      checked,
      drift,
      suspect,
      skills: { applicable: skillsApplicable, status: skillsParityStatus, ok: skillsDoctorOk, text: skillsStatusText },
    }, null, 2));
    process.exit(isOk ? 0 : (opts.mode === 'promote' && suspect.length && !opts.force ? 2 : 1));
  }

  if (!opts.quiet) console.log('');

  if (opts.mode === 'promote' || opts.mode === 'deploy') {
    finishSyncCli(opts, drift, suspect, checked, { applicable: skillsApplicable, status: skillsParityStatus, text: skillsStatusText });
  }

  if (drift.length === 0) {
    if (skillsStatusText && !opts.quiet) console.log(skillsStatusText);
    const extraClean = (skillsApplicable && skillsDoctorOk) ? ', skills parity verified' : '';
    console.log(`sync: clean (${checked} files checked${extraClean})`);
    process.exit(0);
  }

  if (skillsStatusText && !opts.quiet) console.log(skillsStatusText);
  console.log(`sync: ${drift.length}/${checked} items drifted. Run -Promote or -Deploy.`);
  process.exit(1);
}

const isMain = process.argv[1] && (() => {
  try {
    return fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  }
})();
if (isMain) {
  main();
}
