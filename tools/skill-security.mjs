/**
 * tools/skill-security.mjs — offline skill security scanner, eval checker,
 * near-miss trigger evaluator, and registry/lock/README linting.
 *
 * Implements R08 (C2 skills assurance):
 *   - Offline security scanner: shell pipes, credentials, env dumps, network declarations, obfuscation.
 *   - Deterministic per-skill eval requirement: structured eval schema validation with deterministic assertions.
 *   - Near-miss trigger evaluation: fixtures for positive triggers and non-trigger near-misses.
 *   - Registry lint: membership, README, skills-lock.json integrity, and trigger phrasing.
 *
 * Zero external dependencies. Never executes scanned code.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import { createHash } from "node:crypto";
import { parseSkillFrontmatter, extractSkillBody } from "./skill-audit.mjs";

/* ----------------------------------------------------------------- Constants */

const SCRIPT_EXTENSIONS = new Set([".py", ".sh", ".bash", ".ps1", ".js", ".mjs", ".cjs", ".ts"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ...SCRIPT_EXTENSIONS]);

// Shell pipes into interpreters
const SHELL_PIPE_PATTERNS = [
  /curl\s+[^|\r\n]+\|\s*(?:sh|bash|zsh|dash|ksh|python[\d.]*|node|powershell|iex|cmd)\b/i,
  /wget\s+[^|\r\n]+\|\s*(?:sh|bash|zsh|dash|ksh|python[\d.]*|node|powershell|iex|cmd)\b/i,
  /\b(?:fetch|download|http)[^|\r\n]+\|\s*(?:sh|bash|zsh|python|node)\b/i,
  /\|\s*(?:iex|invoke-expression)\b/i,
  /powershell\s+.*\|\s*iex\b/i,
  /\|\s*(?:bash|sh|zsh)\s*(?:-[cesx]+\b)?$/m,
];

// Credentials patterns
const CREDENTIAL_PATTERNS = [
  { rule: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "github-pat", re: /\b(?:ghp_[A-Za-z0-9_]{36}|github_pat_[A-Za-z0-9_]{82})\b/ },
  { rule: "api-key", re: /\bsk-(?:proj-|ant-|live-)?[a-zA-Z0-9_\-]{24,}\b/ },
  { rule: "slack-token", re: /\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/ },
  { rule: "private-key", re: /-----BEGIN [A-Z0-9_\s-]*PRIVATE KEY-----/ },
  { rule: "hardcoded-secret", re: /\b(?:api_key|apikey|secret_key|private_key|auth_token|bearer_token|password)\s*[:=]\s*["'][A-Za-z0-9+/=_\-\.]{16,}["']/i },
];

// Env dumps patterns
const ENV_DUMP_PATTERNS = [
  { rule: "printenv", re: /\bprintenv\b/ },
  { rule: "export-p", re: /\bexport\s+-p\b/ },
  { rule: "process-env-dump", re: /(?:console\.log|JSON\.stringify)\s*\(\s*process\.env\s*\)/ },
  { rule: "process-env-entries", re: /Object\.(?:entries|keys|values)\s*\(\s*process\.env\s*\)/ },
  { rule: "os-environ-dump", re: /(?:print|json\.dumps|dict)\s*\(\s*os\.environ\s*\)/ },
  { rule: "ps-env-dump", re: /(?:Get-ChildItem|dir|ls)\s+Env:/i },
];

// Network patterns in scripts
const NETWORK_CALL_PATTERNS = [
  /\b(?:import\s+urllib\.request|from\s+urllib\.request\s+import)\b/,
  /\b(?:import\s+requests|from\s+requests\s+import)\b/,
  /\b(?:import\s+http\.client|from\s+http\.client\s+import)\b/,
  /\b(?:import\s+aiohttp|from\s+aiohttp\s+import)\b/,
  /\b(?:fetch\s*\(|https?\.request\s*\(|axios\.(?:get|post|put|delete|request)\s*\()/,
  /\b(?:curl|wget)\s+https?:\/\//,
  /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}/, // Raw IP literal
];

// Obfuscation patterns
const OBFUSCATION_PATTERNS = [
  { rule: "base64-pipe-shell", re: /base64\s+(?:-d|--decode)[^|\r\n]*\|\s*(?:sh|bash|zsh|python[\d.]*|node)/i },
  { rule: "eval-buffer-base64", re: /eval\s*\(\s*Buffer\.from\([^)]*['"]base64['"]\)/i },
  { rule: "eval-atob", re: /eval\s*\(\s*atob\(/i },
  { rule: "exec-b64decode", re: /exec\s*\(\s*base64\.b64decode\(/i },
  { rule: "hex-escape-eval", re: /(?:\\x[0-9a-fA-F]{2}){4,}/ },
  { rule: "eval-function", re: /\b(?:eval\s*\(|new\s+Function\s*\(|(?<!\.)\bexec\s*\()/ },
];

/* ----------------------------------------------------------------- File walking */

function walkFiles(dir, options = {}) {
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__" || entry.name === ".coverage") {
        continue;
      }
      if (options.ignoreFixtures && (entry.name === "fixtures" || entry.name === "tests")) {
        continue;
      }
      results.push(...walkFiles(full, options));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

/* ----------------------------------------------------------------- Security Scanner */

/**
 * Scans a skill directory statically for security risks without executing any code.
 *
 * @param {string} skillDir - Path to skill directory
 * @param {object} options - Options { root?: string, ignoreFixtures?: boolean }
 * @returns {object} { ok: boolean, blocked: boolean, findings: Array }
 */
export function scanSkillSecurity(skillDir, options = {}) {
  const root = options.root || process.cwd();
  const skillName = basename(skillDir);
  const findings = [];

  const skillFile = join(skillDir, "SKILL.md");
  let fmText = "";
  if (existsSync(skillFile)) {
    try {
      fmText = readFileSync(skillFile, "utf8");
    } catch {}
  }
  const fm = parseSkillFrontmatter(fmText);

  // Check if network is declared in frontmatter or metadata
  const hasNetworkDeclaration = Boolean(
    /network:\s*(\[|\n|true)/i.test(fmText) ||
    /openclaw:\s*[\s\S]*?network:/i.test(fmText) ||
    /requires:\s*[\s\S]*?network:/i.test(fmText) ||
    /allowed-tools:\s*[\s\S]*?(?:curl|fetch|web-search|browser)/i.test(fmText)
  );

  const files = walkFiles(skillDir, { ignoreFixtures: options.ignoreFixtures });

  for (const file of files) {
    scanFileSecurity(file, root, skillDir, skillName, hasNetworkDeclaration, findings);
  }

  const blocked = findings.some((f) => f.type === "error");
  return {
    ok: !blocked,
    blocked,
    findings,
  };
}

function scanFileSecurity(file, root, skillDir, skillName, hasNetworkDeclaration, findings) {
  const rel = relative(root, file).replace(/\\/g, "/");
  const skillRel = relative(skillDir, file).replace(/\\/g, "/");
  const ext = "." + (file.split(".").pop() || "").toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext) && !SCRIPT_EXTENSIONS.has(ext)) return;

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return;
  }

  checkShellPipes(content, rel, skillRel, skillName, findings);
  checkCredentials(content, rel, skillRel, skillName, findings);
  checkEnvDumps(content, rel, skillRel, skillName, findings);
  const isScript = SCRIPT_EXTENSIONS.has(ext) && (skillRel.startsWith("scripts/") || skillRel.startsWith("src/"));
  if (isScript) checkNetworkCalls(content, rel, skillRel, skillName, hasNetworkDeclaration, findings);
  checkObfuscation(content, rel, skillRel, skillName, isScript, findings);
}

function checkShellPipes(content, rel, skillRel, skillName, findings) {
  for (const pat of SHELL_PIPE_PATTERNS) {
    if (pat.test(content)) {
      findings.push({ skill: skillName, file: rel, type: "error", rule: "security-shell-pipe", message: `Dangerous shell pipe detected in ${skillRel}` });
      break;
    }
  }
}

function checkCredentials(content, rel, skillRel, skillName, findings) {
  for (const { rule, re } of CREDENTIAL_PATTERNS) {
    if (re.test(content)) {
      if (content.includes("AKIAIOSFODNN7EXAMPLE") || content.includes("EXAMPLEKEY")) continue;
      findings.push({ skill: skillName, file: rel, type: "error", rule: `security-credential-${rule}`, message: `Potential hardcoded credential (${rule}) detected in ${skillRel}` });
      break;
    }
  }
}

function checkEnvDumps(content, rel, skillRel, skillName, findings) {
  for (const { rule, re } of ENV_DUMP_PATTERNS) {
    if (re.test(content)) {
      findings.push({ skill: skillName, file: rel, type: "error", rule: "security-env-dump", message: `Process environment dump detected (${rule}) in ${skillRel}` });
      break;
    }
  }
}

function checkNetworkCalls(content, rel, skillRel, skillName, hasNetworkDeclaration, findings) {
  const hasNetguard = content.includes("ALLOWED_HOSTS") || content.includes("ALLOWLIST") || content.includes("_netguard");
  for (const pat of NETWORK_CALL_PATTERNS) {
    if (pat.test(content)) {
      if (!hasNetworkDeclaration && !hasNetguard) {
        findings.push({ skill: skillName, file: rel, type: "error", rule: "security-undeclared-network", message: `Undeclared network call in ${skillRel} without frontmatter network declaration or host allowlist` });
        break;
      }
    }
  }
}

function checkObfuscation(content, rel, skillRel, skillName, isScript, findings) {
  for (const { rule, re } of OBFUSCATION_PATTERNS) {
    if (re.test(content)) {
      if (rule === "eval-function" && (!isScript || skillRel.includes("test") || skillRel.includes("fixture"))) continue;
      findings.push({ skill: skillName, file: rel, type: "error", rule: "security-obfuscation", message: `Potential code obfuscation or dynamic code execution (${rule}) in ${skillRel}` });
      break;
    }
  }
}

/* ----------------------------------------------------------------- Evals Audit */

/**
 * Validates deterministic per-skill eval requirement.
 *
 * @param {string} skillDir - Path to skill directory
 * @param {object} options - Options { requireEvals?: boolean, root?: string }
 * @returns {object} { ok: boolean, evalCount: number, findings: Array }
 */
export function auditSkillEvals(skillDir, options = {}) {
  const root = options.root || process.cwd();
  const skillName = basename(skillDir);
  const findings = [];

  const candidates = [
    join(skillDir, "evals", "evals.json"),
    join(skillDir, "evals.json"),
  ];

  const evalPath = candidates.find((c) => existsSync(c));

  if (!evalPath) {
    if (options.requireEvals) {
      findings.push({
        skill: skillName,
        file: relative(root, skillDir).replace(/\\/g, "/"),
        type: "error",
        rule: "missing-eval-contract",
        message: `Missing required eval specification (evals/evals.json) for skill ${skillName}`,
      });
    }
    return { ok: findings.length === 0, evalCount: 0, findings };
  }

  const rel = relative(root, evalPath).replace(/\\/g, "/");
  let data;
  try {
    data = JSON.parse(readFileSync(evalPath, "utf8"));
  } catch (err) {
    findings.push({
      skill: skillName,
      file: rel,
      type: "error",
      rule: "invalid-eval-contract",
      message: `Malformed eval JSON at ${rel}: ${err.message}`,
    });
    return { ok: false, evalCount: 0, findings };
  }

  if (!data || typeof data !== "object") {
    findings.push({
      skill: skillName,
      file: rel,
      type: "error",
      rule: "invalid-eval-contract",
      message: `Eval file must define a JSON object`,
    });
    return { ok: false, evalCount: 0, findings };
  }

  if (data.skill_name && data.skill_name !== skillName) {
    findings.push({
      skill: skillName,
      file: rel,
      type: "error",
      rule: "invalid-eval-contract",
      message: `skill_name in evals ('${data.skill_name}') does not match directory '${skillName}'`,
    });
  }

  if (!Array.isArray(data.evals) || data.evals.length === 0) {
    findings.push({
      skill: skillName,
      file: rel,
      type: "error",
      rule: "invalid-eval-contract",
      message: `evals array must be present and contain at least one evaluation case`,
    });
    return { ok: false, evalCount: 0, findings };
  }

  let validCases = 0;
  for (let i = 0; i < data.evals.length; i++) {
    if (validateEvalItem(data.evals[i], i, skillName, rel, findings)) {
      validCases++;
    }
  }
  return {
    ok: findings.length === 0,
    evalCount: validCases,
    findings,
  };
}

/* ----------------------------------------------------------------- Trigger Evaluator */

/**
 * Deterministically evaluates whether a prompt triggers a skill or represents
 * a non-trigger near-miss.
 *
 * @param {object|string} skill - Skill object { name, description } or path to skill dir
 * @param {string} prompt - Prompt text to test
 * @param {object} options - Options
 * @returns {object} { triggered: boolean, score: number, matchedTerms: string[], reason: string }
 */
export function evaluateSkillTrigger(skill, prompt, options = {}) {
  const { name, description } = resolveSkillMeta(skill);
  const normPrompt = String(prompt || "").toLowerCase();
  const normDesc = String(description || "").toLowerCase();
  const { terms, matchedTerms } = extractTriggerTerms(name, normDesc, normPrompt);

  const exactNameMatch = normPrompt.includes(name.toLowerCase());
  const { nearMiss, reason: nearMissReason } = checkTriggerNearMiss(normPrompt, options.nearMissIndicators);

  const score = exactNameMatch ? 1.0 : (matchedTerms.length / Math.max(1, terms.length / 3));
  const triggered = !nearMiss && (exactNameMatch || (matchedTerms.length >= 2 && score >= 0.5));

  const reason = nearMissReason || (triggered
    ? `Triggered with matches: ${matchedTerms.join(", ")}`
    : (matchedTerms.length > 0 ? `Near-miss: matched only ${matchedTerms.join(", ")} below trigger threshold` : "No matching terms"));

  return {
    triggered,
    score: Math.min(1.0, score),
    matchedTerms,
    reason,
  };
}

/**
 * Runs a suite of trigger fixtures against a skill.
 *
 * @param {object|string} skill - Skill definition or path
 * @param {Array<{ prompt: string, shouldTrigger: boolean, label?: string }>} fixtures
 * @returns {object} { ok: boolean, passed: number, total: number, failures: Array }
 */
export function evaluateSkillTriggerFixtures(skill, fixtures) {
  let passed = 0;
  const failures = [];

  for (const f of fixtures) {
    const res = evaluateSkillTrigger(skill, f.prompt);
    const success = res.triggered === Boolean(f.shouldTrigger);
    if (success) {
      passed++;
    } else {
      failures.push({
        prompt: f.prompt,
        expected: f.shouldTrigger,
        actual: res.triggered,
        score: res.score,
        reason: res.reason,
        label: f.label || "",
      });
    }
  }

  return {
    ok: failures.length === 0,
    passed,
    total: fixtures.length,
    failures,
  };
}

/* ----------------------------------------------------------------- Registry & Lock Lint */

/**
 * Validates registry membership, README links, skills-lock.json integrity, and trigger phrasing.
 *
 * @param {string} root - Repository root
 * @param {object} options - Options
 * @returns {object} { ok: boolean, findings: Array }
 */
export function lintSkillRegistry(root, options = {}) {
  const findings = [];
  const baseRoot = resolve(root || process.cwd());
  const skillsDir = join(baseRoot, "skills");

  if (!existsSync(skillsDir)) {
    findings.push({
      skill: "registry",
      file: "skills",
      type: "error",
      rule: "missing-skills-directory",
      message: `Skills directory not found at ${skillsDir}`,
    });
    return { ok: false, findings };
  }

  lintSkillDirectories(skillsDir, findings);
  lintSkillsLock(baseRoot, findings);
  lintReadmeSkills(baseRoot, findings);

  const hasErrors = findings.some((f) => f.type === "error");
  return { ok: !hasErrors, findings };
}

function validateEvalItem(ev, i, skillName, rel, findings) {
  if (!ev || typeof ev !== "object") {
    findings.push({ skill: skillName, file: rel, type: "error", rule: "invalid-eval-contract", message: `eval case at index ${i} is not an object` });
    return false;
  }
  if (!ev.prompt || typeof ev.prompt !== "string" || !ev.prompt.trim()) {
    findings.push({ skill: skillName, file: rel, type: "error", rule: "invalid-eval-contract", message: `eval case ${ev.id || i} missing prompt string` });
  }
  if (!ev.expected_output || typeof ev.expected_output !== "string" || !ev.expected_output.trim()) {
    findings.push({ skill: skillName, file: rel, type: "error", rule: "invalid-eval-contract", message: `eval case ${ev.id || i} missing expected_output string` });
  }
  if (!Array.isArray(ev.assertions) || ev.assertions.length === 0) {
    findings.push({ skill: skillName, file: rel, type: "error", rule: "invalid-eval-contract", message: `eval case ${ev.id || i} must have a non-empty assertions array` });
  }
  return true;
}

function resolveSkillMeta(skill) {
  if (typeof skill === "string") {
    const sFile = join(skill, "SKILL.md");
    if (existsSync(sFile)) {
      const parsed = parseSkillFrontmatter(readFileSync(sFile, "utf8"));
      return { name: parsed.name || basename(skill), description: parsed.description || "" };
    }
    return { name: basename(skill), description: "" };
  }
  if (skill && typeof skill === "object") {
    return { name: skill.name || "", description: skill.description || "" };
  }
  return { name: "", description: "" };
}

function extractTriggerTerms(name, normDesc, normPrompt) {
  const nameParts = name.toLowerCase().split(/[-_]/).filter((p) => p.length > 2);
  const triggerMatch = /(?:use when|use for|use this when|useful for|when the user)\s+([^.]+)/i.exec(normDesc);
  const triggerScope = triggerMatch ? triggerMatch[1] : normDesc;
  const terms = Array.from(new Set([
    ...nameParts,
    ...triggerScope.match(/\b[a-z]{3,}\b/g) || [],
  ])).filter((t) => !["the", "and", "for", "with", "when", "this", "that", "user"].includes(t));

  const matchedTerms = [];
  for (const term of terms) {
    if (new RegExp(`\\b${term}`, "i").test(normPrompt) || (term.length >= 4 && normPrompt.includes(term))) {
      matchedTerms.push(term);
    }
  }
  return { terms, matchedTerms };
}

function checkTriggerNearMiss(normPrompt, indicators) {
  if (!indicators) return { nearMiss: false, reason: "" };
  for (const indicator of indicators) {
    if (normPrompt.includes(indicator.toLowerCase())) {
      return { nearMiss: true, reason: `Matches near-miss indicator '${indicator}'` };
    }
  }
  return { nearMiss: false, reason: "" };
}

function lintSkillDirectories(skillsDir, findings) {
  const entries = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);

  const seenNames = new Map();
  for (const dirName of entries) {
    lintOneSkillDir(dirName, skillsDir, seenNames, findings);
  }
}

function lintOneSkillDir(dirName, skillsDir, seenNames, findings) {
  const sDir = join(skillsDir, dirName);
  const sFile = join(sDir, "SKILL.md");
  if (!existsSync(sFile)) {
    findings.push({ skill: dirName, file: `skills/${dirName}`, type: "error", rule: "orphan-skill-directory", message: `Directory skills/${dirName} does not contain a SKILL.md` });
    return;
  }
  try {
    const text = readFileSync(sFile, "utf8");
    const { name, description } = parseSkillFrontmatter(text);
    const declared = name || dirName;
    if (seenNames.has(declared)) {
      findings.push({ skill: dirName, file: `skills/${dirName}/SKILL.md`, type: "error", rule: "duplicate-skill-name", message: `Skill name '${declared}' already declared by skills/${seenNames.get(declared)}` });
    } else {
      seenNames.set(declared, dirName);
    }
    lintSkillDescription(dirName, description, findings);
  } catch (err) {
    findings.push({ skill: dirName, file: `skills/${dirName}/SKILL.md`, type: "error", rule: "unreadable-skill-file", message: `Cannot parse SKILL.md: ${err.message}` });
  }
}

function lintSkillDescription(dirName, description, findings) {
  if (!description) {
    findings.push({ skill: dirName, file: `skills/${dirName}/SKILL.md`, type: "error", rule: "trigger-lint-empty", message: `Skill '${dirName}' is missing frontmatter description for routing` });
  } else if (!/(?:use when|use for|when|use to|useful for)/i.test(description)) {
    findings.push({ skill: dirName, file: `skills/${dirName}/SKILL.md`, type: "recommendation", rule: "trigger-lint-directive", message: `Description for '${dirName}' lacks an actionable trigger directive ('Use when...', 'Use for...')` });
  }
}

function lintSkillsLock(baseRoot, findings) {
  const lockPath = join(baseRoot, "skills-lock.json");
  if (!existsSync(lockPath)) return;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (lock.version !== 1) {
      findings.push({ skill: "registry", file: "skills-lock.json", type: "error", rule: "invalid-lock-version", message: `skills-lock.json version must be 1 (got ${lock.version})` });
    }
    const skillsObj = lock.skills || {};
    for (const [sKey, sVal] of Object.entries(skillsObj)) {
      if (!sVal || typeof sVal !== "object") continue;
      const hash = sVal.computedHash || sVal.hash || sVal.sha256;
      if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
        findings.push({ skill: sKey, file: "skills-lock.json", type: "error", rule: "invalid-lock-hash", message: `Invalid or missing SHA-256 hash for locked skill '${sKey}'` });
      }
      if (!existsSync(join(baseRoot, "skills", sKey))) {
        findings.push({ skill: sKey, file: "skills-lock.json", type: "error", rule: "orphan-locked-skill", message: `Locked skill '${sKey}' is listed in skills-lock.json but not found in skills/` });
      }
    }
  } catch (err) {
    findings.push({ skill: "registry", file: "skills-lock.json", type: "error", rule: "invalid-lock-json", message: `Failed to parse skills-lock.json: ${err.message}` });
  }
}

function lintReadmeSkills(baseRoot, findings) {
  const readmePath = join(baseRoot, "README.md");
  if (!existsSync(readmePath)) return;
  try {
    const readme = readFileSync(readmePath, "utf8");
    if (!readme.includes("skills") && !readme.includes("skills.sh")) {
      findings.push({ skill: "registry", file: "README.md", type: "recommendation", rule: "readme-skills-reference", message: "Root README.md does not mention skills or the skills registry" });
    }
  } catch {}
}
