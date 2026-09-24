#!/usr/bin/env node
/**
 * skills-doctor.mjs — registry health for installed skills.
 *
 * The skill registry is snapshotted at session start, so a skill that fails to
 * parse is dropped SILENTLY: the agent never sees it and nothing reports the
 * loss. This tool finds those failures before a session does.
 *
 * Checks, per SKILL.md under ~/.agents/skills:
 *   1. frontmatter    — `name:` and `description:` present; description quoted
 *                       exactly once (an unclosed quote makes the whole
 *                       frontmatter unparsable and the skill is dropped).
 *   2. truncation     — file is not a prefix of its repo counterpart (the real
 *                       failure mode seen in the wild: a bad copy leaves a
 *                       half-written file that still "looks" fine).
 *   3. parity         — installed copy matches the repo copy byte-for-byte
 *                       (line-ending normalized).
 *   4. orphan         — skill exists in the repo but was never installed.
 *   5. duplicate-name — two directories declare the same `name:`.
 *
 * Skills the operator disabled on purpose (`<agents-home>/.skills-disabled.json`)
 * are reported as `info: disabled by operator` and are exempt from every check
 * above: the operator already removed them from the registry, so they are not
 * orphans and not parity problems. A list that cannot be read degrades to empty
 * (plus a note) instead of silently dropping the exemptions.
 *
 * Exit 0 = healthy, 1 = problems found, 2 = cannot run.
 * Zero dependencies. Node 18+ / Bun.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/* ----------------------------------------------------------------- utilities */

const norm = (s) => s.replace(/\r\n/g, "\n");
const sha = (s) => createHash("sha256").update(norm(s), "utf8").digest("hex").slice(0, 16);

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(norm(text));
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/** A description that opens a quote but never closes it breaks the parser. */
function quoteBalanced(v) {
  if (!v) return false;
  if (!v.startsWith('"')) return true;          // unquoted is fine
  return v.length > 1 && v.endsWith('"') && !v.endsWith('\\"');
}

function listSkillDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .filter((n) => existsSync(join(root, n, "SKILL.md")));
}

/**
 * Operator-disabled registry: `<agentsHome>/.skills-disabled.json`
 * (`{version, disabled: [names], note?}`). Returns the names plus notes for a
 * list that could not be read — a corrupt file must not silently re-enable the
 * orphan/parity noise the exemptions exist to suppress.
 */
function readDisabled(agentsHome) {
  const path = join(agentsHome, ".skills-disabled.json");
  const bad = (detail) => ({ disabled: [], notes: [{ skill: null, detail }] });
  if (!existsSync(path)) return { disabled: [], notes: [] };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return bad(`${path}: invalid JSON (${e.message}) -> disabled list treated as EMPTY`);
  }
  if (!parsed || !Array.isArray(parsed.disabled)) {
    return bad(`${path}: no 'disabled' array -> disabled list treated as EMPTY`);
  }
  const disabled = [...new Set(parsed.disabled.filter((n) => typeof n === "string").map((n) => n.trim()).filter(Boolean))];
  return { disabled, notes: [] };
}
function isRepoRoot(dir) {
  if (!dir || !existsSync(dir)) return false;
  return existsSync(join(dir, "install.ps1")) && existsSync(join(dir, "agent", "models.yml.example"));
}

function resolveDefaultRepoRoot(scriptDir, agentsHome) {
  const repoCandidates = [
    // If running deployed in <harness>/tools, check sibling workflow-repo first
    resolve(scriptDir, "..", "workflow-repo"),
    // If running directly in <repo>/tools
    resolve(scriptDir, ".."),
  ];

  if (process.env.REPO_ROOT) {
    repoCandidates.push(process.env.REPO_ROOT);
  }

  const pointerPath = agentsHome
    ? join(dirname(agentsHome), ".omp", "agent", ".harness-root")
    : join(homedir(), ".omp", "agent", ".harness-root");
  try {
    const hRoot = readFileSync(pointerPath, "utf8").trim();
    if (hRoot) {
      repoCandidates.push(join(hRoot, "workflow-repo"));
    }
  } catch {}

  if (process.env.HARNESS_ROOT) {
    repoCandidates.push(join(process.env.HARNESS_ROOT, "workflow-repo"));
  }

  for (const cand of repoCandidates) {
    if (cand && isRepoRoot(cand)) {
      const skillsDir = join(cand, "skills");
      if (existsSync(skillsDir) && listSkillDirs(skillsDir).length > 0) {
        return skillsDir;
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------- checks */

function run(installedRoot, repoRoot, disabled = [], agentsHome = null) {
  const problems = [];
  const notes = [];
  const names = new Map();
  const disabledSet = new Set(disabled);

  const present = listSkillDirs(installedRoot);
  const installed = present.filter((n) => !disabledSet.has(n));
  const repoExists = Boolean(repoRoot && existsSync(repoRoot));
  const repo = repoExists ? listSkillDirs(repoRoot) : [];
  const repoNames = new Set(repo);

  if (!repoExists) {
    problems.push({
      skill: "(repo)",
      kind: "parity",
      detail: `comparison repo not found (${repoRoot || "none"}) -> parity UNVERIFIED`,
    });
  } else if (repo.length === 0) {
    problems.push({
      skill: "(repo)",
      kind: "parity",
      detail: `comparison repo has 0 skills (${repoRoot}) -> parity UNVERIFIED`,
    });
  }
  const infos = [...disabledSet].sort().map((skill) => ({
    skill,
    detail: present.includes(skill) ? "disabled by operator (still on disk - checks skipped)" : "disabled by operator",
  }));

  for (const name of installed) {
    const path = join(installedRoot, name, "SKILL.md");
    const text = readFileSync(path, "utf8");
    const fm = parseFrontmatter(text);

    if (!fm) { problems.push({ skill: name, kind: "frontmatter", detail: "no parsable --- frontmatter block" }); continue; }
    if (!fm.name) problems.push({ skill: name, kind: "frontmatter", detail: "missing `name:`" });
    if (!fm.description) problems.push({ skill: name, kind: "frontmatter", detail: "missing `description:`" });
    else if (!quoteBalanced(fm.description)) {
      problems.push({ skill: name, kind: "frontmatter", detail: `unclosed description quote -> skill is DROPPED from the registry` });
    }

    if (fm.name) {
      if (names.has(fm.name)) {
        problems.push({ skill: name, kind: "duplicate-name", detail: `also declared by '${names.get(fm.name)}'` });
      } else names.set(fm.name, name);
    }
    if (fm.name && fm.name !== name) {
      notes.push({ skill: name, kind: "name-differs", detail: `declares name '${fm.name}' (directory is '${name}')` });
    }

  // The installer substitutes the <HARNESS> placeholder with the machine's
  // harness root on install (see install.ps1). Parity must compare the repo
  // template against the substituted copy, so normalise the installed text
  // back to the placeholder before hashing.
  // The pointer is read from the AGENTS home being checked (`--agents-home`), not
  // from the machine's real ~/.omp: verifying a sandbox or a second harness would
  // otherwise find no pointer, skip normalisation, and report every templated
  // skill as a parity failure.
  const harnessPointer = agentsHome
    ? join(dirname(agentsHome), ".omp", "agent", ".harness-root")
    : join(homedir(), ".omp", "agent", ".harness-root");
  let harnessRoot = "";
  try {
    harnessRoot = readFileSync(harnessPointer, "utf8").trim();
  } catch { /* no harness pointer — nothing to normalise */ }
  const normaliseInstalled = (text) => {
    if (!harnessRoot) return text;
    const slash = harnessRoot.replace(/\\/g, "/");
    return text.split(slash).join("<HARNESS>").split(harnessRoot).join("<HARNESS>");
  };

    if (repoRoot && repoNames.has(name)) {
      const repoText = readFileSync(join(repoRoot, name, "SKILL.md"), "utf8");
      // Canonicalise BOTH sides to the placeholder. Normalising only the installed
      // copy breaks when the comparison repo is itself an installed harness (its
      // skills are already substituted), and when it is the clone (its skills still
      // hold <HARNESS>), leaving a false parity failure in either direction.
      const iSha = sha(normaliseInstalled(text));
      const rSha = sha(normaliseInstalled(repoText));
      if (iSha !== rSha) {
        // Compare the SAME normalised text used for hashing; raw text carries
        // the resolved harness path and would misfire the truncation heuristic.
        const instNorm = norm(normaliseInstalled(text));
        const repoNorm = norm(normaliseInstalled(repoText));
        const truncated = repoNorm.startsWith(instNorm.trimEnd()) || instNorm.length < repoNorm.length * 0.9;
        problems.push({
          skill: name,
          kind: truncated ? "truncation" : "parity",
          detail: truncated
            ? `installed copy looks TRUNCATED (${instNorm.length} vs ${repoNorm.length} bytes)`
            : `installed copy differs from repo (${iSha} vs ${rSha})`,
        });
      }
    }
  }

  // Mojibake check: a file written with the wrong encoding round-trips through
  // UTF-8 as 'â€' / 'â€¦' sequences. It parses fine, so nothing else catches it,
  // but the text is silently destroyed for every reader.
  for (const name of installed) {
    const text = readFileSync(join(installedRoot, name, 'SKILL.md'), 'utf8');
    // The signature is a Latin-1 interpretation of UTF-8 continuation bytes:
    // U+00C2/U+00C3 and U+00E2 followed by U+0080..U+00BF, e.g. 'T1\u00e2\u0080\u0093T3'.
    if (/[\u00c2\u00c3\u00e2][\u0080-\u00bf]/.test(text)) {
      problems.push({ skill: name, kind: 'encoding', detail: 'mojibake detected - file was written with the wrong encoding' });
    }
  }

  if (repoExists) {
    for (const n of repo) {
      if (installed.includes(n) || disabledSet.has(n)) continue;
      problems.push({ skill: n, kind: "orphan", detail: "in repo but NOT installed -> skill:// will not resolve" });
    }
  }

  const parityProblems = problems.filter((p) => ["parity", "truncation", "orphan"].includes(p.kind));
  const parityStatus = (!repoExists || repo.length === 0)
    ? "UNVERIFIED"
    : (parityProblems.length === 0 ? "VERIFIED" : "DRIFT");

  return {
    problems,
    notes,
    infos,
    installedCount: installed.length,
    repoCount: repo.length,
    disabledCount: infos.length,
    parityStatus,
  };
}

export { run, listSkillDirs, readDisabled, parseFrontmatter, resolveDefaultRepoRoot };

/* ---------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
let installedRoot = null, repoRoot = null, agentsHome = null, json = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--installed") installedRoot = argv[++i];
  else if (argv[i] === "--repo") repoRoot = argv[++i];
  else if (argv[i] === "--agents-home") agentsHome = argv[++i];
  else if (argv[i] === "--json") json = true;
}
const home = process.env.USERPROFILE || process.env.HOME || "";
installedRoot = installedRoot || join(home, ".agents", "skills");
agentsHome = agentsHome || dirname(installedRoot);

const scriptDir = typeof import.meta.dirname === "string"
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url));

if (!repoRoot) {
  repoRoot = resolveDefaultRepoRoot(scriptDir, agentsHome);
}

if (!existsSync(installedRoot)) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: `installed root not found: ${installedRoot}` }));
    process.exit(2);
  }
  console.error(`skills-doctor: installed root not found: ${installedRoot}`);
  process.exit(2);
}

const disabledList = readDisabled(agentsHome);
const { problems, notes, infos, installedCount, repoCount, disabledCount, parityStatus } = run(installedRoot, repoRoot, disabledList.disabled, agentsHome);
notes.push(...disabledList.notes);

if (json) {
  console.log(JSON.stringify({
    ok: problems.length === 0,
    parityStatus,
    installedCount,
    repoCount,
    disabledCount,
    problems,
    notes,
    infos,
  }, null, 2));
  process.exit(problems.length === 0 ? 0 : 1);
}

console.log(`skills-doctor: ${installedCount} installed, ${repoCount} in repo${disabledCount ? `, ${disabledCount} disabled by operator` : ""}${parityStatus === "UNVERIFIED" ? " [parity UNVERIFIED]" : ""}`);

if (infos.length) {
  console.log("\n  info");
  for (const i of infos) console.log(`    ${i.skill}: ${i.detail}`);
}

if (notes.length) {
  console.log("\n  notes (informational)");
  for (const n of notes) console.log(`    ${n.skill ? `${n.skill}: ` : ""}${n.detail}`);
}

if (!problems.length) {
  console.log("  all checks passed (frontmatter, truncation, parity, orphans, names).");
  process.exit(0);
}

console.log(`\n  ${problems.length} problem(s):\n`);
const width = Math.max(...problems.map((p) => p.kind.length));
for (const p of problems) console.log(`    ${p.skill.padEnd(28)} ${p.kind.padEnd(width)}  ${p.detail}`);
console.log("\n  A skill that fails to parse is dropped from the registry SILENTLY.");
process.exit(1);
