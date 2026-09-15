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
 * Exit 0 = healthy, 1 = problems found, 2 = cannot run.
 * Zero dependencies. Node 18+ / Bun.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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

/* -------------------------------------------------------------------- checks */

function run(installedRoot, repoRoot) {
  const problems = [];
  const notes = [];
  const names = new Map();

  const installed = listSkillDirs(installedRoot);
  const repo = repoRoot && existsSync(repoRoot) ? listSkillDirs(repoRoot) : [];
  const repoNames = new Set(repo);

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

    if (repoRoot && repoNames.has(name)) {
      const repoText = readFileSync(join(repoRoot, name, "SKILL.md"), "utf8");
      const iSha = sha(text), rSha = sha(repoText);
      if (iSha !== rSha) {
        const truncated = norm(repoText).startsWith(norm(text).trimEnd()) || norm(text).length < norm(repoText).length * 0.9;
        problems.push({
          skill: name,
          kind: truncated ? "truncation" : "parity",
          detail: truncated
            ? `installed copy looks TRUNCATED (${norm(text).length} vs ${norm(repoText).length} bytes)`
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
      if (!installed.includes(n)) problems.push({ skill: n, kind: "orphan", detail: "in repo but NOT installed -> skill:// will not resolve" });
    }
  }

  return { problems, notes, installedCount: installed.length, repoCount: repo.length };
}

/* ---------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
let installedRoot = null, repoRoot = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--installed") installedRoot = argv[++i];
  else if (argv[i] === "--repo") repoRoot = argv[++i];
}
const home = process.env.USERPROFILE || process.env.HOME || "";
installedRoot = installedRoot || join(home, ".agents", "skills");
repoRoot = repoRoot || "<harness>/workflow-repo/skills";

if (!existsSync(installedRoot)) {
  console.error(`skills-doctor: installed root not found: ${installedRoot}`);
  process.exit(2);
}

const { problems, notes, installedCount, repoCount } = run(installedRoot, repoRoot);

console.log(`skills-doctor: ${installedCount} installed, ${repoCount} in repo`);

if (notes.length) {
  console.log("\n  notes (informational)");
  for (const n of notes) console.log(`    ${n.skill}: ${n.detail}`);
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
