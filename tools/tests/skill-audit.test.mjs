/**
 * tools/tests/skill-audit.test.mjs — tests for structural skill and reference validation.
 *
 * Verifies R03:
 *   - Body line count excluding frontmatter
 *   - Reference resolution (broken links and fragment validation)
 *   - Fenced code block and external/placeholder URI ignoring
 *   - Long reference navigation index requirement (>100 lines)
 *   - Direct resource discovery detection
 *   - JEV description length risk advice
 *   - CLI exit codes (0 for clean/recommendations, 1 for errors, 2 for malformed input)
 *   - Stable JSON structure { ok, skills, findings }
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  extractSkillBody,
  parseSkillFrontmatter,
  checkMarkdownReferences,
  auditSkillFile,
  auditSkills,
} from "../skill-audit.mjs";

const CLI_PATH = fileURLToPath(new URL("../prompt-lint.mjs", import.meta.url));

function runCli(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("extractSkillBody strips frontmatter and normalizes CRLF and BOM", () => {
  const content = "\uFEFF---\r\nname: test-skill\r\ndescription: A test\r\n---\r\n# Body Line 1\r\nBody Line 2";
  const body = extractSkillBody(content);
  assert.equal(body, "# Body Line 1\nBody Line 2");

  const noFm = "# Plain Body\nLine 2";
  assert.equal(extractSkillBody(noFm), noFm);
});

test("parseSkillFrontmatter parses single-line, multi-line scalar, and quoted descriptions", () => {
  const fmText = `---
name: "demo-skill"
description: >
  A multi-line folded
  description string
---
# Body`;
  const parsed = parseSkillFrontmatter(fmText);
  assert.equal(parsed.name, "demo-skill");
  assert.equal(parsed.description, "A multi-line folded description string");
});

test("body line count recommendation fires when body > 500 lines without affecting frontmatter metadata", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skill-body-test-"));
  try {
    const skillDir = join(tmp, "big-skill");
    mkdirSync(skillDir, { recursive: true });

    const lines = ["# Big Skill Body", ...Array(510).fill("A content line")].join("\n");
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: big-skill\ndescription: Short description\n---\n${lines}\n`,
      "utf8",
    );

    const audit = auditSkillFile(skillDir, { root: tmp });
    assert.ok(audit.bodyLines > 500, `Expected body > 500 lines, got ${audit.bodyLines}`);
    const sizeFinding = audit.findings.find((f) => f.rule === "skill-body-size");
    assert.ok(sizeFinding, "Expected skill-body-size finding");
    assert.equal(sizeFinding.type, "recommendation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reference checker fails on missing target file and broken fragment anchor", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ref-broken-test-"));
  try {
    const skillDir = join(tmp, "ref-skill");
    mkdirSync(join(skillDir, "references"), { recursive: true });

    writeFileSync(
      join(skillDir, "references", "guide.md"),
      "# Guide\n\n## Existing Section\nSome content\n",
      "utf8",
    );

    const skillContent = `---
name: ref-skill
description: Reference testing skill
---
# Skill
See [Missing Guide](references/missing.md).
See [Existing Valid](references/guide.md#existing-section).
See [Broken Fragment](references/guide.md#missing-section).
`;
    writeFileSync(join(skillDir, "SKILL.md"), skillContent, "utf8");

    const audit = auditSkillFile(skillDir, { root: tmp });
    assert.equal(audit.valid, false);

    const missingRef = audit.findings.find((f) => f.rule === "broken-reference");
    assert.ok(missingRef, "Expected broken-reference finding");
    assert.equal(missingRef.type, "error");
    assert.ok(missingRef.message.includes("missing.md"));

    const brokenFrag = audit.findings.find((f) => f.rule === "broken-fragment");
    assert.ok(brokenFrag, "Expected broken-fragment finding");
    assert.equal(brokenFrag.type, "error");
    assert.ok(brokenFrag.message.includes("missing-section"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("reference checker supports GitHub repeated-hyphen anchors and duplicate headings", () => {
  const tmp = mkdtempSync(join(tmpdir(), "slugger-test-"));
  try {
    const skillDir = join(tmp, "slug-skill");
    mkdirSync(join(skillDir, "references"), { recursive: true });

    const targetContent = `# Target Document

## 4.6 Data & Form Patterns
Content for data and form.

## OAuth / SSO Flows
Content for oauth and sso.

## Step 1: Install & Setup
Content for step 1.

## Repeated Section
First occurrence.

## Repeated Section
Second occurrence.

## Custom ID Section {#custom-target}
Section with custom ID.
`;
    writeFileSync(join(skillDir, "references", "target.md"), targetContent, "utf8");

    const skillContent = `---
name: slug-skill
description: Testing repeated hyphens and duplicate headings
---
# Skill

- [Data & Form](references/target.md#46-data--form-patterns)
- [OAuth / SSO](references/target.md#oauth--sso-flows)
- [Step 1](references/target.md#step-1-install--setup)
- [Repeated First](references/target.md#repeated-section)
- [Repeated Second](references/target.md#repeated-section-1)
- [Custom Anchor](references/target.md#custom-target)
`;
    writeFileSync(join(skillDir, "SKILL.md"), skillContent, "utf8");

    const audit = auditSkillFile(skillDir, { root: tmp });
    const fragmentErrors = audit.findings.filter((f) => f.rule === "broken-fragment");
    assert.equal(
      fragmentErrors.length,
      0,
      `Expected 0 broken fragment errors, got: ${JSON.stringify(fragmentErrors)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reference checker ignores fenced examples, URLs, and placeholders", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ref-ignore-test-"));
  try {
    const skillDir = join(tmp, "ignore-skill");
    mkdirSync(join(skillDir, "references"), { recursive: true });

    writeFileSync(
      join(skillDir, "references", "real.md"),
      "# Real Reference\nContent\n",
      "utf8",
    );

    const content = `---
name: ignore-skill
description: Ignore test
---
# Test

\`\`\`markdown
[Code Example Link](references/not-real.md)
[Fenced Placeholder](path/to/missing.md)
\`\`\`

External and placeholder links:
- [Web Link](https://example.com/docs)
- [Internal URI](skill://agent-browser/open)
- [Rule URI](rule://enterprise-directives)
- [Placeholder Path](path/to/<anchor>.md)
- [Real Link](references/real.md)
`;
    writeFileSync(join(skillDir, "SKILL.md"), content, "utf8");

    const audit = auditSkillFile(skillDir, { root: tmp });
    const errors = audit.findings.filter((f) => f.type === "error");
    assert.equal(errors.length, 0, `Expected 0 errors, got: ${JSON.stringify(errors)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("long reference navigation check requires heading index for files > 100 lines", () => {
  const tmp = mkdtempSync(join(tmpdir(), "long-ref-test-"));
  try {
    const skillDir = join(tmp, "nav-skill");
    mkdirSync(join(skillDir, "references"), { recursive: true });

    // File 1: > 100 lines without index
    const longNoIndex = ["# Long File Without Index", ...Array(110).fill("Paragraph text here.")].join("\n");
    writeFileSync(join(skillDir, "references", "unindexed.md"), longNoIndex, "utf8");

    // File 2: > 100 lines with index
    const longWithIndex = [
      "# Long File With Index",
      "",
      "## Contents",
      "- [Section One](#section-one)",
      "- [Section Two](#section-two)",
      "",
      "## Section One",
      ...Array(60).fill("Content 1"),
      "## Section Two",
      ...Array(60).fill("Content 2"),
    ].join("\n");
    writeFileSync(join(skillDir, "references", "indexed.md"), longWithIndex, "utf8");

    const skillContent = `---
name: nav-skill
description: Navigation index testing
---
# Skill
- [Unindexed](references/unindexed.md)
- [Indexed](references/indexed.md)
`;
    writeFileSync(join(skillDir, "SKILL.md"), skillContent, "utf8");

    const audit = auditSkillFile(skillDir, { root: tmp });
    const navFindings = audit.findings.filter((f) => f.rule === "long-reference-navigation");
    assert.equal(navFindings.length, 1);
    assert.ok(navFindings[0].file.includes("unindexed.md"));
    assert.equal(navFindings[0].type, "recommendation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("direct resource discovery detects unreferenced files in references/", () => {
  const tmp = mkdtempSync(join(tmpdir(), "discovery-test-"));
  try {
    const skillDir = join(tmp, "disc-skill");
    mkdirSync(join(skillDir, "references"), { recursive: true });

    writeFileSync(join(skillDir, "references", "linked.md"), "# Linked\nContent\n", "utf8");
    writeFileSync(join(skillDir, "references", "orphan.md"), "# Orphan\nContent\n", "utf8");

    const skillContent = `---
name: disc-skill
description: Discovery testing
---
# Skill
See [Linked Doc](references/linked.md).
`;
    writeFileSync(join(skillDir, "SKILL.md"), skillContent, "utf8");

    const audit = auditSkillFile(skillDir, { root: tmp });
    const discFindings = audit.findings.filter((f) => f.rule === "resource-discovery");
    assert.equal(discFindings.length, 1);
    assert.ok(discFindings[0].file.includes("orphan.md"));
    assert.equal(discFindings[0].type, "recommendation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("JEV description length risk advice explains 500-char truncation boundary", () => {
  const tmp = mkdtempSync(join(tmpdir(), "jev-desc-test-"));
  try {
    const skillDir = join(tmp, "jev-skill");
    mkdirSync(skillDir, { recursive: true });

    const longDesc = "a".repeat(520);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: jev-skill\ndescription: "${longDesc}"\n---\n# Body\n`,
      "utf8",
    );

    const audit = auditSkillFile(skillDir, { root: tmp });
    const jevFinding = audit.findings.find((f) => f.rule === "jev-description-limit");
    assert.ok(jevFinding, "Expected jev-description-limit finding");
    assert.equal(jevFinding.type, "recommendation");
    assert.ok(jevFinding.message.includes("500"));
    assert.ok(jevFinding.message.includes("JEV"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI prompt-lint skills command enforces exit codes and JSON contract", () => {
  const tmp = mkdtempSync(join(tmpdir(), "cli-skills-test-"));
  try {
    mkdirSync(join(tmp, "skills", "good-skill"), { recursive: true });
    mkdirSync(join(tmp, "skills", "bad-skill"), { recursive: true });

    writeFileSync(
      join(tmp, "skills", "good-skill", "SKILL.md"),
      "---\nname: good-skill\ndescription: Short\n---\n# Good Body\n",
      "utf8",
    );
    writeFileSync(
      join(tmp, "skills", "bad-skill", "SKILL.md"),
      "---\nname: bad-skill\ndescription: Short\n---\n# Bad Body\n[Broken Link](references/missing.md)\n",
      "utf8",
    );

    // 1. Without --check, exits 0 and prints report
    const noCheck = runCli(["skills", "--root", tmp]);
    assert.equal(noCheck.status, 0);
    assert.ok(noCheck.stdout.includes("prompt-lint: skill structural audit"));

    // 2. With --check, exits 1 due to actionable structural error in bad-skill
    const withCheck = runCli(["skills", "--root", tmp, "--check"]);
    assert.equal(withCheck.status, 1);

    // 3. With --json, returns structured object matching schema
    const jsonRun = runCli(["skills", "--root", tmp, "--json"]);
    assert.equal(jsonRun.status, 0);
    const parsed = JSON.parse(jsonRun.stdout);
    assert.equal(typeof parsed.ok, "boolean");
    assert.equal(parsed.ok, false); // errors present
    assert.ok(Array.isArray(parsed.skills));
    assert.ok(Array.isArray(parsed.findings));

    // 4. Malformed options or missing root exit 2
    const missingRoot = runCli(["skills", "--root", join(tmp, "non-existent")]);
    assert.equal(missingRoot.status, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("all four assigned restructured skills have body lines < 500 lines and valid references", () => {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const targets = ["design-taste-frontend", "paseo-plugin", "refero-design", "docker-patterns"];

  for (const name of targets) {
    const sDir = join(root, "skills", name);
    assert.ok(existsSync(sDir), `Skill directory must exist: ${sDir}`);
    const res = auditSkillFile(sDir, { root });
    assert.ok(
      res.bodyLines <= 500,
      `Skill ${name} body must be <= 500 lines, found: ${res.bodyLines}`,
    );

    const brokenErrors = res.findings.filter((f) => f.type === "error");
    assert.equal(
      brokenErrors.length,
      0,
      `Skill ${name} should have 0 broken reference errors, found: ${JSON.stringify(brokenErrors)}`,
    );
  }
});
