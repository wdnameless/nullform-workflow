#!/usr/bin/env node
/**
 * tools/agent-lint.mjs — structural audit of agent definitions (agent/agents/*.md).
 *
 * Why this exists instead of `agnix`: agnix validates tool names against the
 * Claude convention (`Read`, `Bash`), but this harness is portable and its canon
 * is the OMP vocabulary (`read`, `bash`) — verified by `omp agents unpack`, whose
 * bundled agents declare exactly that lower-case set. Linting our files against a
 * foreign convention produced eleven permanent "errors" that described no real
 * defect, so the check was replaced with one that encodes OUR contract.
 *
 * Checks (each a real defect if violated):
 *   1. YAML frontmatter present and parseable.
 *   2. `name` present, matching the filename.
 *   3. `description` present and non-empty.
 *   4. `tools` names belong to the known vocabulary (extensible: unknown names are
 *      reported as warnings so a new tool can ship before this list updates).
 *   5. `spawns` targets exist as agent files.
 *
 * CLI: node tools/agent-lint.mjs [--root <dir>] [--json] [--check]
 * Exit: 0 clean, 1 findings (with --check), 2 input error.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { loadYaml } from "./installation/config.mjs";

/**
 * Tool vocabulary of the host harness (OMP), extracted from the bundled agent
 * definitions rather than guessed. Names outside this set are warnings, not errors:
 * a harness may add tools and the lint must not block that.
 */
export const KNOWN_TOOLS = Object.freeze([
  "read", "write", "edit", "find", "grep", "glob", "bash", "lsp", "browser",
  "task", "ask", "web_search", "ast_grep", "yield", "todowrite", "notebookedit",
  "mcp__codegraph_explore", "mcp__codebase_index_codebase_context",
]);

/** Stock agents bundled with the host harness (`omp agents unpack`). */
export const BUILTIN_AGENTS = Object.freeze(["scout", "seance", "task", "security-reviewer", "sonic", "reviewer"]);

/** Keys a frontmatter may carry. Unknown keys are reported: a typo silently does nothing. */
const KNOWN_KEYS = Object.freeze([
  "name", "description", "tools", "spawns", "model", "thinkingLevel", "output", "version", "mode",
]);

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match ? match[1] : null;
}

function toolNames(tools) {
  if (Array.isArray(tools)) return tools.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tools === "string") {
    return tools.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Audit one agents directory. Returns findings, each `{ file, check, severity, detail }`.
 * @param {string} root project or harness root
 */
export function lintAgents(root = ".") {
  const yaml = loadYaml();
  const dir = join(resolve(root), "agent", "agents");
  const findings = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: true, checked: 0, findings: [], note: "no agent/agents directory" };
  }
  const entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  // Our own agents plus the host's bundled ones: `spawns: scout` targets a stock
  // OMP role that ships with the harness, so it is legitimate without a local file.
  const known = new Set([...entries.map((f) => basename(f, ".md")), ...BUILTIN_AGENTS]);

  for (const file of entries) {
    const rel = `agent/agents/${file}`;
    const text = readFileSync(join(dir, file), "utf8");
    const fmText = frontmatter(text);
    if (fmText === null) {
      findings.push({ file: rel, check: "frontmatter", severity: "error", detail: "missing YAML frontmatter block" });
      continue;
    }
    let fm;
    try {
      fm = yaml.parse(fmText) || {};
    } catch (error) {
      findings.push({ file: rel, check: "frontmatter", severity: "error", detail: `unparseable frontmatter: ${error.message}` });
      continue;
    }

    const expected = basename(file, ".md");
    if (!fm.name) findings.push({ file: rel, check: "name", severity: "error", detail: "missing name" });
    else if (String(fm.name) !== expected) {
      findings.push({ file: rel, check: "name", severity: "error", detail: `name "${fm.name}" does not match filename "${expected}"` });
    }

    if (!fm.description || !String(fm.description).trim()) {
      findings.push({ file: rel, check: "description", severity: "error", detail: "missing or empty description" });
    }

    for (const tool of toolNames(fm.tools)) {
      if (!KNOWN_TOOLS.includes(tool)) {
        findings.push({ file: rel, check: "tools", severity: "warning", detail: `unknown tool "${tool}" (add it to KNOWN_TOOLS if real)` });
      }
    }

    for (const spawned of toolNames(fm.spawns)) {
      if (spawned === "*") continue;
      if (!known.has(spawned)) {
        findings.push({ file: rel, check: "spawns", severity: "error", detail: `spawns unknown agent "${spawned}"` });
      }
    }

    for (const key of Object.keys(fm)) {
      if (!KNOWN_KEYS.includes(key)) {
        findings.push({ file: rel, check: "keys", severity: "warning", detail: `unknown frontmatter key "${key}"` });
      }
    }
  }

  const errors = findings.filter((f) => f.severity === "error");
  return { ok: errors.length === 0, checked: entries.length, findings, errors: errors.length, warnings: findings.length - errors.length };
}

export function formatFindings(result) {
  if (!result.checked) return result.note || "agent-lint: nothing to check";
  if (!result.findings.length) return `agent-lint: ${result.checked} agent(s) clean`;
  return result.findings
    .map((f) => `  [${f.severity.toUpperCase()}] ${f.file} (${f.check}): ${f.detail}`)
    .join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  const rootFlag = args.indexOf("--root");
  const root = rootFlag >= 0 && args[rootFlag + 1] ? args[rootFlag + 1] : ".";
  const json = args.includes("--json");
  const check = args.includes("--check");
  if (args.includes("--help") || args.includes("-h")) {
    console.log("agent-lint.mjs — structural audit of agent/agents/*.md\n\n  node agent-lint.mjs [--root <dir>] [--json] [--check]");
    return 0;
  }
  const result = lintAgents(root);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatFindings(result));
  return check && !result.ok ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
