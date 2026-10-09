import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const README_PATH = resolve(REPO_ROOT, "README.md");

test("README.md exists and is readable", () => {
  assert.equal(existsSync(README_PATH), true, "README.md must exist in repo root");
  const content = readFileSync(README_PATH, "utf8");
  assert.ok(content.length > 0, "README.md must not be empty");
});

test("README.md contains 'Установка одной фразой' section", () => {
  const content = readFileSync(README_PATH, "utf8");
  assert.match(
    content,
    /Установка одной фразой/i,
    "README.md must contain 'Установка одной фразой' section heading"
  );
});

test("README.md contains a copy-paste prompt block with R03 requirements", () => {
  const content = readFileSync(README_PATH, "utf8");

  // Extract the section starting at 'Установка одной фразой'
  const sectionMatch = content.match(/#+\s+Установка одной фразой[\s\S]*?(?=\n#+ |\n---|\n## |$)/i);
  assert.ok(sectionMatch, "Should find 'Установка одной фразой' section body");
  const sectionText = sectionMatch[0];

  // Must contain a fenced code block with prompt
  const codeBlockMatch = sectionText.match(/```(?:markdown|text|prompt)?\s*([\s\S]*?)```/);
  assert.ok(codeBlockMatch, "Section must contain a fenced code block with the copy-paste prompt");
  const promptText = codeBlockMatch[1];

  // 1. Mentions supported harness list via --help (not hardcoded)
  assert.match(
    promptText,
    /--help/i,
    "Prompt must instruct to check supported harnesses via --help"
  );

  // 2. Mentions detection order: explicit markers -> detectHarness / auto
  assert.match(
    promptText,
    /(?:маркер|marker)/i,
    "Prompt must instruct checking explicit harness markers first"
  );
  assert.match(
    promptText,
    /(?:detectHarness|--harness\s+auto|auto)/i,
    "Prompt must instruct fallback to detectHarness or --harness auto"
  );

  // 3. Mentions key harnesses: openclaw, hermes, openhuman, and omp
  assert.match(promptText, /openclaw/i, "Prompt must mention openclaw");
  assert.match(promptText, /hermes/i, "Prompt must mention hermes");
  assert.match(promptText, /openhuman/i, "Prompt must mention openhuman");
  assert.match(promptText, /omp/i, "Prompt must mention omp");

  // 4. Mentions dry-run first
  assert.match(
    promptText,
    /--dry-run/i,
    "Prompt must instruct running --dry-run first"
  );

  // 5. Mentions harness-to-installed table / per-harness set (skills, plugins, methodologies/roles/mcp)
  assert.match(
    promptText,
    /(?:таблиц|table)/i,
    "Prompt must instruct showing a summary table of what will be installed"
  );

  // 6. Mentions asking for user confirmation before applying
  assert.match(
    promptText,
    /(?:подтвержд|confirm)/i,
    "Prompt must instruct asking user confirmation before applying changes"
  );

  // 7. Mentions install-harness.mjs
  assert.match(
    promptText,
    /install-harness\.mjs/i,
    "Prompt must reference tools/install-harness.mjs"
  );
});

test("README.md contains English 'One-Phrase Install' section with prompt block", () => {
  const content = readFileSync(README_PATH, "utf8");
  assert.match(content, /One-Phrase Install/i, "README.md must contain English 'One-Phrase Install' heading");

  const sectionMatch = content.match(/#+\s+One-Phrase Install[\s\S]*?(?=\n#+ |\n---|\n## |$)/i);
  assert.ok(sectionMatch, "Should find English 'One-Phrase Install' section body");
  const sectionText = sectionMatch[0];

  const codeBlockMatch = sectionText.match(/```(?:markdown|text|prompt)?\s*([\s\S]*?)```/);
  assert.ok(codeBlockMatch, "English section must contain a fenced code block with prompt");
  const promptText = codeBlockMatch[1];

  assert.match(promptText, /--help/i, "Prompt must mention --help");
  assert.match(promptText, /marker/i, "Prompt must mention explicit markers");
  assert.match(promptText, /(?:detectHarness|--harness\s+auto|auto)/i, "Prompt must mention fallback auto-detect");
  assert.match(promptText, /openclaw/i, "Prompt must mention openclaw");
  assert.match(promptText, /hermes/i, "Prompt must mention hermes");
  assert.match(promptText, /openhuman/i, "Prompt must mention openhuman");
  assert.match(promptText, /omp/i, "Prompt must mention omp");
  assert.match(promptText, /--dry-run/i, "Prompt must mention --dry-run");
  assert.match(promptText, /table/i, "Prompt must mention table");
  assert.match(promptText, /confirm/i, "Prompt must mention user confirmation");
  assert.match(promptText, /install-harness\.mjs/i, "Prompt must mention install-harness.mjs");
});
