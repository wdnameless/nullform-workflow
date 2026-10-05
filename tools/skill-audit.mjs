/**
 * tools/skill-audit.mjs — structural skill and reference validation.
 *
 * Implements R03:
 *   - Body line count excluding YAML frontmatter
 *   - Local markdown reference destination and fragment resolution (GitHub GFM anchor slugger)
 *   - Long reference navigation index verification (>100 lines)
 *   - Direct resource discovery check
 *   - JEV first 500 description character risk explanation
 *   - Stable JSON output { ok, skills, findings }
 *   - --check exits 1 on actionable structural errors, 0 otherwise
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";

/**
 * Extracts Markdown body excluding YAML frontmatter.
 * Normalizes Windows CRLF and strips optional UTF-8 BOM.
 */
export function extractSkillBody(text) {
  const norm = String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n[\s\S]*?\n---\n?/.exec(norm);
  if (!m) return norm;
  return norm.slice(m[0].length);
}

/**
 * Parses frontmatter key-value pairs (name and description).
 */
export function parseSkillFrontmatter(text) {
  const norm = String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---/.exec(norm);
  if (!m) return { name: "", description: "" };

  const lines = m[1].split("\n");
  let name = "";
  let description = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameMatch = /^name:\s*(.*)$/.exec(line);
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const descMatch = /^description:\s*(.*)$/.exec(line);
    if (descMatch) {
      let val = descMatch[1].trim();
      if (val === ">" || val === "|" || val === ">-" || val === "|-") {
        const buf = [];
        i++;
        while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
          buf.push(lines[i].trim());
          i++;
        }
        i--;
        description = buf.join(" ");
      } else {
        description = val.replace(/^["']|["']$/g, "");
      }
    }
  }

  return { name, description };
}

/**
 * Strips fenced code blocks (``` or ~~~) so example code/links are ignored.
 */
function stripFencedBlocks(markdown) {
  return markdown.replace(/(^|\n)(```+|~~~+)[^\n]*\n[\s\S]*?(\n\2[^\n]*(\n|$)|$)/g, "$1\n");
}

/**
 * Checks whether a URI has an external or internal scheme that should be ignored.
 */
function isIgnoredUri(target) {
  if (!target || typeof target !== "string") return true;
  const trimmed = target.trim();
  if (trimmed.startsWith("#")) return false; // same-file fragment
  // Ignore external URLs & protocol links
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return true;
  // Ignore placeholder paths (<...>, ..., $ARGUMENTS, ${...}, etc.)
  if (/<[a-zA-Z0-9_.-]+>/.test(trimmed)) return true;
  if (trimmed.includes("...") || trimmed.includes("${") || trimmed.includes("$ARGUMENTS")) return true;
  if (/^path\/to\//i.test(trimmed)) return true;
  return false;
}

/**
 * Collects anchor slugs and explicit HTML IDs from markdown text using GitHub GFM rules.
 * Preserves repeated hyphens produced when punctuation surrounded by spaces is removed.
 * Tracks duplicate headings with incremental numeric suffixes (-1, -2, ...).
 */
function collectDocumentAnchors(content) {
  const anchors = new Set();
  const slugCounts = new Map();
  const clean = stripFencedBlocks(content);
  const lines = clean.split("\n");

  for (const line of lines) {
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (headingMatch) {
      const fullHeading = headingMatch[1].trim();
      const customIdMatch = /\{#([a-zA-Z0-9_-]+)\}/.exec(fullHeading);
      if (customIdMatch) {
        anchors.add(customIdMatch[1].toLowerCase());
      }
      const headingTitle = fullHeading.replace(/\{#.*?\}/, "").trim();

      // GitHub GFM slug algorithm:
      // 1. Lowercase
      // 2. Remove punctuation: strip characters that are not letters, numbers, spaces, hyphens, underscores
      // 3. Convert all whitespace characters to hyphens
      const gfmSlug = headingTitle
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-");

      const count = slugCounts.get(gfmSlug) || 0;
      slugCounts.set(gfmSlug, count + 1);

      const disambiguated = count === 0 ? gfmSlug : `${gfmSlug}-${count}`;
      anchors.add(disambiguated);
      anchors.add(gfmSlug);
      // Also register collapsed-hyphen variants so single-hyphen authored links resolve cleanly
      anchors.add(disambiguated.replace(/-+/g, "-"));
      anchors.add(gfmSlug.replace(/-+/g, "-"));
    }
    const htmlAnchorMatch = /<(?:a|span|div)[^>]*(?:id|name)=["']([^"']+)["']/g;
    let htmlMatch;
    while ((htmlMatch = htmlAnchorMatch.exec(line)) !== null) {
      anchors.add(htmlMatch[1].toLowerCase());
    }
  }

  return anchors;
}

/**
 * Checks whether a markdown reference file has a navigable heading index.
 */
function hasNavigableHeadingIndex(content) {
  const clean = stripFencedBlocks(content);
  // Matches a Contents/Navigation heading or list of internal anchor links
  if (/^#{1,4}\s+(?:contents|navigation|table\s+of\s+contents|quick\s+reference|index)\b/im.test(clean)) {
    return true;
  }
  const internalAnchorLinks = clean.match(/\[[^\]]+\]\(#[a-zA-Z0-9_-]+\)/g);
  return Boolean(internalAnchorLinks && internalAnchorLinks.length >= 2);
}

/**
 * Verifies local Markdown references and fragments within a markdown file.
 */
export function checkMarkdownReferences(sourceFilePath, content, skillName = "") {
  const findings = [];
  const referencedFiles = [];
  const cleanContent = stripFencedBlocks(content);

  // Match Markdown links [text](destination)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;

  while ((match = linkRegex.exec(cleanContent)) !== null) {
    const rawDest = match[2].trim();
    if (isIgnoredUri(rawDest)) continue;

    const hashIdx = rawDest.indexOf("#");
    const filePathPart = hashIdx === -1 ? rawDest : rawDest.slice(0, hashIdx);
    const fragmentPart = hashIdx === -1 ? "" : rawDest.slice(hashIdx + 1);

    // Resolve target path relative to source file
    let targetFilePath = sourceFilePath;
    if (filePathPart.length > 0) {
      targetFilePath = resolve(dirname(sourceFilePath), filePathPart);
      referencedFiles.push(targetFilePath);

      if (!existsSync(targetFilePath)) {
        findings.push({
          skill: skillName,
          file: sourceFilePath,
          type: "error",
          rule: "broken-reference",
          message: `Inaccessible local reference '${rawDest}' from ${sourceFilePath}`,
          target: targetFilePath,
        });
        continue;
      }
    }

    // Verify fragment anchor if present
    if (fragmentPart.length > 0 && existsSync(targetFilePath)) {
      try {
        const targetText = readFileSync(targetFilePath, "utf8");
        const availableAnchors = collectDocumentAnchors(targetText);
        const cleanFragment = decodeURIComponent(fragmentPart).toLowerCase();
        if (!availableAnchors.has(cleanFragment) && !availableAnchors.has(cleanFragment.replace(/-+/g, "-"))) {
          findings.push({
            skill: skillName,
            file: sourceFilePath,
            type: "error",
            rule: "broken-fragment",
            message: `Inaccessible fragment '#${fragmentPart}' in ${targetFilePath}`,
            target: `${targetFilePath}#${fragmentPart}`,
          });
        }
      } catch (err) {
        findings.push({
          skill: skillName,
          file: sourceFilePath,
          type: "error",
          rule: "broken-reference",
          message: `Cannot read target file for fragment check: ${err.message}`,
          target: targetFilePath,
        });
      }
    }
  }

  return { findings, referencedFiles };
}

/**
 * Audits a single skill directory and its SKILL.md.
 */
export function auditSkillFile(skillDir, options = {}) {
  const findings = [];
  const skillFile = join(skillDir, "SKILL.md");

  if (!existsSync(skillFile)) {
    return {
      name: relative(options.root || process.cwd(), skillDir),
      dir: skillDir,
      skillFile,
      bodyLines: 0,
      references: [],
      valid: false,
      findings: [{
        skill: relative(options.root || process.cwd(), skillDir),
        file: skillFile,
        type: "error",
        rule: "missing-skill-file",
        message: `SKILL.md not found in ${skillDir}`,
      }],
    };
  }

  let rawContent;
  try {
    rawContent = readFileSync(skillFile, "utf8");
  } catch (err) {
    return {
      name: relative(options.root || process.cwd(), skillDir),
      dir: skillDir,
      skillFile,
      bodyLines: 0,
      references: [],
      valid: false,
      findings: [{
        skill: relative(options.root || process.cwd(), skillDir),
        file: skillFile,
        type: "error",
        rule: "unreadable-file",
        message: `Cannot read ${skillFile}: ${err.message}`,
      }],
    };
  }

  const { name: fmName, description } = parseSkillFrontmatter(rawContent);
  const skillName = fmName || relative(options.root || process.cwd(), skillDir).replace(/\\/g, "/");

  // Check 1: Body line count (excluding frontmatter)
  const bodyText = extractSkillBody(rawContent);
  const bodyLines = bodyText.length === 0 ? 0 : bodyText.split("\n").length;
  if (bodyLines > 500) {
    findings.push({
      skill: skillName,
      file: skillFile,
      type: "recommendation",
      rule: "skill-body-size",
      message: `Body exceeds 500 lines (${bodyLines} lines, excluding frontmatter)`,
    });
  }

  // Check 2: JEV first 500 description characters limit risk
  if (description.length > 500) {
    findings.push({
      skill: skillName,
      file: skillFile,
      type: "recommendation",
      rule: "jev-description-limit",
      message: `Frontmatter description has ${description.length} characters (> 500 limit). JEV assistance criteria uses description.slice(0, 500); triggers or instructions beyond 500 chars risk truncation during automated skill routing`,
    });
  }

  // Check 3: Markdown references from SKILL.md
  const { findings: refFindings, referencedFiles } = checkMarkdownReferences(skillFile, rawContent, skillName);
  findings.push(...refFindings);

  const directReferences = new Set(referencedFiles);

  // Check 4: Deep audit of local referenced markdown files
  for (const refPath of directReferences) {
    if (existsSync(refPath) && refPath.endsWith(".md")) {
      try {
        const refContent = readFileSync(refPath, "utf8");
        const refLines = refContent.split("\n").length;

        // Long reference navigation (>100 lines) check
        if (refLines > 100 && !hasNavigableHeadingIndex(refContent)) {
          findings.push({
            skill: skillName,
            file: refPath,
            type: "recommendation",
            rule: "long-reference-navigation",
            message: `Reference file '${relative(skillDir, refPath).replace(/\\/g, "/")}' exceeds 100 lines (${refLines} lines) without a navigable heading index`,
          });
        }

        // Sub-references validation
        const sub = checkMarkdownReferences(refPath, refContent, skillName);
        findings.push(...sub.findings);
      } catch (err) {
        findings.push({
          skill: skillName,
          file: refPath,
          type: "error",
          rule: "broken-reference",
          message: `Failed to inspect reference file: ${err.message}`,
        });
      }
    }
  }

  // Check 5: Direct resource discovery for files in references/
  const referencesDir = join(skillDir, "references");
  if (existsSync(referencesDir) && statSync(referencesDir).isDirectory()) {
    try {
      const dirEntries = readdirSync(referencesDir, { withFileTypes: true });
      for (const ent of dirEntries) {
        if (ent.isFile() && ent.name.endsWith(".md")) {
          const fullPath = resolve(referencesDir, ent.name);
          if (!directReferences.has(fullPath)) {
            findings.push({
              skill: skillName,
              file: fullPath,
              type: "recommendation",
              rule: "resource-discovery",
              message: `Reference file 'references/${ent.name}' is not directly referenced from SKILL.md`,
            });
          }
        }
      }
    } catch {
      // Ignore unreadable references dir
    }
  }

  const hasErrors = findings.some((f) => f.type === "error");

  return {
    name: skillName,
    dir: skillDir,
    skillFile,
    bodyLines,
    references: Array.from(directReferences),
    valid: !hasErrors,
    findings,
  };
}

/**
 * Audits all skills under <root>/skills.
 */
export function auditSkills(root, options = {}) {
  const baseRoot = root || process.cwd();
  const skillsDir = join(baseRoot, "skills");

  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
    return {
      ok: false,
      skills: [],
      findings: [{
        skill: "all",
        file: skillsDir,
        type: "error",
        rule: "missing-skills-directory",
        message: `Skills directory not found at '${skillsDir}'`,
      }],
    };
  }

  const entries = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const auditedSkills = [];
  const allFindings = [];

  for (const name of entries) {
    const sDir = join(skillsDir, name);
    const result = auditSkillFile(sDir, { root: baseRoot, ...options });
    auditedSkills.push({
      name: result.name,
      dir: relative(baseRoot, result.dir).replace(/\\/g, "/"),
      skillFile: relative(baseRoot, result.skillFile).replace(/\\/g, "/"),
      bodyLines: result.bodyLines,
      references: result.references.map((r) => relative(baseRoot, r).replace(/\\/g, "/")),
      valid: result.valid,
    });
    allFindings.push(...result.findings.map((f) => ({
      ...f,
      file: relative(baseRoot, f.file).replace(/\\/g, "/"),
      target: f.target ? relative(baseRoot, f.target).replace(/\\/g, "/") : undefined,
    })));
  }

  const hasErrors = allFindings.some((f) => f.type === "error");

  return {
    ok: !hasErrors,
    skills: auditedSkills,
    findings: allFindings,
  };
}

/**
 * CLI command runner for prompt-lint skills command.
 */
export function cmdSkills(root, home, asJson, checkMode) {
  const res = auditSkills(root);

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log("prompt-lint: skill structural audit\n");
    console.log(`Audited ${res.skills.length} skills in ${root}`);

    const errors = res.findings.filter((f) => f.type === "error");
    const recommendations = res.findings.filter((f) => f.type === "recommendation" || f.type === "warning");

    if (errors.length > 0) {
      console.log(`\nActionable Structural Errors (${errors.length}):`);
      for (const err of errors) {
        console.log(`  [ERROR] ${err.skill}: ${err.message} (${err.file})`);
      }
    } else {
      console.log("\nNo structural errors found.");
    }

    if (recommendations.length > 0) {
      console.log(`\nRecommendations and Advisory Warnings (${recommendations.length}):`);
      for (const rec of recommendations) {
        console.log(`  [WARN]  ${rec.skill}: ${rec.message} (${rec.file})`);
      }
    }
  }

  if (checkMode) {
    const hasErrors = res.findings.some((f) => f.type === "error");
    return hasErrors ? 1 : 0;
  }

  return 0;
}
