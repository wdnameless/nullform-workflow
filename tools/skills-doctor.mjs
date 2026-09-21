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
import { join, dirname } from "node:path";
import { homedir } from "node:os";

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

/* -------------------------------------------------------------------- checks */

function run(installedRoot, repoRoot, disabled = []) {
  const problems = [];
  const notes = [];
  const names = new Map();
  const disabledSet = new Set(disabled);

  const present = listSkillDirs(installedRoot);
  const installed = present.filter((n) => !disabledSet.has(n));
  const repo = repoRoot && existsSync(repoRoot) ? listSkillDirs(repoRoot) : [];
  const repoNames = new Set(repo);

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
  let harnessRoot = "";
  try {
    harnessRoot = readFileSync(join(homedir(), ".omp", "agent", ".harness-root"), "utf8").trim();
  } catch { /* no harness pointer — nothing to normalise */ }
  const normaliseInstalled = (text) => {
    if (!harnessRoot) return text;
    const slash = harnessRoot.replace(/\\/g, "/");
    return text.split(slash).join("<HARNESS>").split(harnessRoot).join("<HARNESS>");
  };

    if (repoRoot && repoNames.has(name)) {
      const repoText = readFileSync(join(repoRoot, name, "SKILL.md"), "utf8");
      const iSha = sha(normaliseInstalled(text)), rSha = sha(repoText);
      if (iSha !== rSha) {
        // Compare the SAME normalised text used for hashing; raw text carries
        // the resolved harness path and would misfire the truncation heuristic.
        const instNorm = norm(normaliseInstalled(text));
        const truncated = norm(repoText).startsWith(instNorm.trimEnd()) || instNorm.length < norm(repoText).length * 0.9;
        problems.push({
          skill: name,
          kind: truncated ? "truncation" : "parity",
          detail: truncated
            ? `installed copy looks TRUNCATED (${instNorm.length} vs ${norm(repoText).length} bytes)`
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

  if (repoRoot) {
    for (const n of repo) {
      if (installed.includes(n) || disabledSet.has(n)) continue;
      problems.push({ skill: n, kind: "orphan", detail: "in repo but NOT installed -> skill:// will not resolve" });
    }
  }

  return { problems, notes, infos, installedCount: installed.length, repoCount: repo.length, disabledCount: infos.length };
}

/* ---------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
let installedRoot = null, repoRoot = null, agentsHome = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--installed") installedRoot = argv[++i];
  else if (argv[i] === "--repo") repoRoot = argv[++i];
  else if (argv[i] === "--agents-home") agentsHome = argv[++i];
}
const home = process.env.USERPROFILE || process.env.HOME || "";
installedRoot = installedRoot || join(home, ".agents", "skills");
repoRoot = repoRoot || "<harness>/workflow-repo/skills";
agentsHome = agentsHome || dirname(installedRoot);

if (!existsSync(installedRoot)) {
  console.error(`skills-doctor: installed root not found: ${installedRoot}`);
  process.exit(2);
}

const disabledList = readDisabled(agentsHome);
const { problems, notes, infos, installedCount, repoCount, disabledCount } = run(installedRoot, repoRoot, disabledList.disabled);
notes.push(...disabledList.notes);

console.log(`skills-doctor: ${installedCount} installed, ${repoCount} in repo${disabledCount ? `, ${disabledCount} disabled by operator` : ""}`);

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
