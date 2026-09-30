/**
 * tools/jev-assist.mjs
 * Pure Node stdlib implementation of JEV automatic assistance core runtime:
 * - Credentials: env fallback with optional Bun.secrets native vault lookup.
 * - Catalog: effective project/user .agents/.omp skill metadata with duplicate precedence, operator disabled handling, and secret screening.
 * - Screening: email, secrets, PII, credentials, code dumps, attachments, continuation, and risk filtering before any externalization.
 * - Decisions: bounded OpenRouter POST /api/alpha/decisions client with strict type, bounds, model, and cost validation.
 * - Policy & Evaluation: deterministic fingerprints, raw denominator hurdle recomputation, and strict activation verification.
 * - Telemetry: minimal redacted aggregate session events without raw prompts, keys, or error dumps.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DECISION_MODEL = "typesafe/jev-1.13";
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const LEAF_ARCHETYPES = new Set(["lookup", "json-transform", "formatting", "text-normalization"]);
const ALL_ARCHETYPES = new Set(["lookup", "json-transform", "formatting", "text-normalization", "none"]);

// ---------------------------------------------------------------------------
// 1. Credentials
// ---------------------------------------------------------------------------

/**
 * Reads OpenRouter/JEV API credentials from the environment or native vault.
 * Never prints or returns credentials in logs or reports.
 * @returns {Promise<string|null>}
 */
export async function readCredential() {
  const envKey = process.env.OPENROUTER_API_KEY || process.env.JEV_API_KEY;
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    return envKey.trim();
  }

  if (typeof Bun !== "undefined" && Bun?.secrets?.get) {
    try {
      const secret = await Bun.secrets.get({
        service: "nullform-workflow",
        name: "openrouter-api-key",
      });
      if (typeof secret === "string" && secret.trim().length > 0) {
        return secret.trim();
      }
    } catch {
      // Native vault lookup failed or unsupported; degrade silently
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 2. Secret & PII Detection
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /sk-(?:or-v1-)?[A-Za-z0-9_-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9_]{59}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bAIza[0-9A-Za-z-_]{35}\b/,
  /\bxox[baprs]-[0-9A-Za-z-_]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/,
  /(?:aws_secret_access_key|aws_session_token)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/i,
  /(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(?:api[_-]?key|secret|token|password|passwd|bearer|пароль)\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{8,}["']?/i,
  /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i,
];

const PII_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b(?:\d{4}[ -]?){3}\d{4}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
];

const CODE_DUMP_PATTERNS = [
  /^diff --git/m,
  /(?:^@@ -\d+,\d+ \+\d+,\d+ @@[\s\S]*?){2,}/m,
  /^--- [ab]\/.*\n\+\+\+ [ab]\//m,
  /(?:^\s*at\s+[\w.<>$]+ \([^)]+:\d+:\d+\)\s*){3,}/m,
  /\bdata:[a-zA-Z0-9\/-]+;base64,[A-Za-z0-9+/=]{40,}\b/i,
  /\b[A-Za-z0-9+/]{120,}={0,2}\b/,
];

const CONTINUATION_PATTERNS = [
  /^(?:continue|proceed|go on|same as above|do it again|as discussed|apply this|fix that)\.?$/i,
  /^(?:продолжай|продолжи|делай|как выше|как и раньше|сделай так же|исправь это|примени это)\.?$/i,
];

const RISKY_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i,
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\bformat\s+[a-z]:/i,
  /\b(?:cat\s+\/etc\/shadow|chmod\s+777\s+\/)\b/i,
  /\b(?:mkfs(?:\.[a-z0-9]+)?|dd\s+if=)\b/i,
  /\bpush\s+--force\s+(?:origin\s+)?(?:main|master)\b/i,
];

/**
 * Checks whether text contains raw secret tokens or PII (distinct from semantic security terms).
 * @param {string} text
 * @returns {boolean}
 */
function hasRawSecretOrPii(text) {
  if (typeof text !== "string") return false;
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(text)) return true;
  }
  for (const pat of PII_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 3. Skill Catalog
// ---------------------------------------------------------------------------

function parseSkillMetadata(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const norm = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    if (!norm.startsWith("---")) return { name: null, description: "" };

    const endIdx = norm.indexOf("\n---", 3);
    if (endIdx === -1) return { name: null, description: "" };

    const fmLines = norm.slice(3, endIdx).split("\n");
    let name = null;
    let description = "";

    for (let i = 0; i < fmLines.length; i++) {
      const line = fmLines[i].trim();
      const nameMatch = /^name:\s*(.*)$/i.exec(line);
      if (nameMatch) {
        name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
        continue;
      }
      const descMatch = /^description:\s*(.*)$/i.exec(line);
      if (descMatch) {
        let val = descMatch[1].trim();
        if (val === ">" || val === "|" || val === ">-" || val === "|-") {
          const buf = [];
          i++;
          while (i < fmLines.length && (fmLines[i].startsWith(" ") || fmLines[i].startsWith("\t") || !fmLines[i].trim())) {
            const nextTrimmed = fmLines[i].trim();
            if (nextTrimmed) buf.push(nextTrimmed);
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
  } catch {
    return { name: null, description: "" };
  }
}

function readDisabledSkills(cwd, home) {
  const disabled = new Set();
  const candidateFiles = [
    join(cwd, ".agents", ".skills-disabled.json"),
    join(cwd, ".skills-disabled.json"),
    join(cwd, ".omp", "skills-disabled.json"),
    join(home, ".agents", ".skills-disabled.json"),
    join(home, ".omp", "skills-disabled.json"),
  ];

  for (const file of candidateFiles) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const list = Array.isArray(parsed?.disabled) ? parsed.disabled : (Array.isArray(parsed) ? parsed : []);
      for (const item of list) {
        if (typeof item === "string" && item.trim()) {
          disabled.add(item.trim());
        }
      }
    } catch {
      // Ignored
    }
  }

  return disabled;
}

/**
 * Loads effective skills metadata across project and user roots, or from authoritative effectiveSkills records.
 * Honors operator-disabled skills, duplicate precedence, and bounds metadata.
 * @param {{ cwd?: string, home?: string, roots?: string[], effectiveSkills?: Array<{ name: string, description?: string, path?: string }> }} [options]
 * @returns {{ skills: Array<{ name: string, description: string, path: string }>, fingerprint: string }}
 */
export function loadSkillCatalog({ cwd = process.cwd(), home = process.env.USERPROFILE || process.env.HOME || "", roots, effectiveSkills } = {}) {
  const disabledSet = readDisabledSkills(cwd, home);
  const seenNames = new Set();
  const collected = [];

  const isValidName = (name) => {
    if (!name || name.length > 100) return false;
    return /^[a-zA-Z0-9_.:/@-]+$/.test(name);
  };

  if (Array.isArray(effectiveSkills)) {
    for (const s of effectiveSkills) {
      if (!s || typeof s !== "object") continue;
      const rawName = typeof s.name === "string" ? s.name.trim() : "";
      const skillName = rawName.startsWith("skill:") ? rawName.slice(6).trim() : rawName;
      if (!isValidName(skillName)) continue;
      if (disabledSet.has(skillName)) continue;
      if (seenNames.has(skillName)) continue;

      const boundedDesc = (typeof s.description === "string" ? s.description : "").slice(0, 1000);
      if (hasRawSecretOrPii(skillName) || hasRawSecretOrPii(boundedDesc)) {
        continue;
      }

      seenNames.add(skillName);
      collected.push({
        name: skillName,
        description: boundedDesc,
        path: typeof s.path === "string" ? s.path : "",
      });

      if (collected.length >= 256) break;
    }
  } else {
    const effectiveRoots = Array.isArray(roots) && roots.length > 0
      ? roots
      : [
          join(cwd, ".agents", "skills"),
          join(cwd, ".omp", "skills"),
          join(cwd, "skills"),
          join(home, ".agents", "skills"),
          join(home, ".omp", "skills"),
        ];

    for (const root of effectiveRoots) {
      if (!root || !existsSync(root)) continue;
      let entries = [];
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDirName = entry.name;
        const candidatePaths = [
          join(root, skillDirName, "SKILL.md"),
          join(root, skillDirName, "skill.md"),
        ];

        let targetPath = null;
        for (const p of candidatePaths) {
          if (existsSync(p)) {
            targetPath = p;
            break;
          }
        }
        if (!targetPath) continue;

        const { name: parsedName, description } = parseSkillMetadata(targetPath);
        const skillName = (parsedName || skillDirName).trim();
        if (!isValidName(skillName)) continue;

        if (disabledSet.has(skillName)) continue;
        if (seenNames.has(skillName)) continue;

        const boundedDesc = (description || "").slice(0, 1000);

        // Screen metadata for actual embedded secrets/PII (allows semantic security words)
        if (hasRawSecretOrPii(skillName) || hasRawSecretOrPii(boundedDesc)) {
          continue;
        }

        seenNames.add(skillName);
        collected.push({
          name: skillName,
          description: boundedDesc,
          path: targetPath,
        });

        if (collected.length >= 256) break;
      }
      if (collected.length >= 256) break;
    }
  }

  collected.sort((a, b) => a.name.localeCompare(b.name));
  const metaString = collected.map((s) => `${s.name}:${s.description}`).join("\n");
  const fingerprint = createHash("sha256").update(metaString, "utf8").digest("hex");

  return { skills: collected, fingerprint };
}

// ---------------------------------------------------------------------------
// 4. Task Screening
// ---------------------------------------------------------------------------

/**
 * Screens prompt/task text for secrets, PII (including emails), code dumps, continuation-only, and risk.
 * @param {unknown} text
 * @returns {{ allowed: boolean, reason: string }}
 */
export function screenTask(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { allowed: false, reason: "empty-task" };
  }

  const trimmed = text.trim();

  if (trimmed.length > 8000) {
    return { allowed: false, reason: "overlong" };
  }

  // PII (email, card, ssn)
  for (const pat of PII_PATTERNS) {
    if (pat.test(trimmed)) {
      return { allowed: false, reason: "pii" };
    }
  }

  // Secrets & credentials
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(trimmed)) {
      return { allowed: false, reason: "secret" };
    }
  }

  // Code dumps & attachments
  if (/```[\s\S]*?```/.test(trimmed)) {
    const codeBlocks = trimmed.match(/```[\s\S]*?```/g) || [];
    for (const block of codeBlocks) {
      const lineCount = block.split("\n").length;
      if (lineCount > 15 || block.length > 800) {
        return { allowed: false, reason: "code-dump" };
      }
    }
  }
  for (const pat of CODE_DUMP_PATTERNS) {
    if (pat.test(trimmed)) {
      return { allowed: false, reason: "code-dump" };
    }
  }

  // Continuation / context-only
  for (const pat of CONTINUATION_PATTERNS) {
    if (pat.test(trimmed)) {
      return { allowed: false, reason: "context-only" };
    }
  }

  // High-risk commands
  for (const pat of RISKY_PATTERNS) {
    if (pat.test(trimmed)) {
      return { allowed: false, reason: "risky" };
    }
  }

  return { allowed: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// 5. Decisions API Client
// ---------------------------------------------------------------------------

/**
 * Executes a single bounded decision request to OpenRouter.
 * Strictly validates response types, answers, models, and usage costs.
 * Never estimates unknown costs as 0 or clamps bad values into cheap route.
 * @param {{
 *   task: string,
 *   skills?: Array<{ name: string, description: string }>,
 *   apiKey: string,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   model?: string
 * }} options
 * @returns {Promise<{
 *   status: 'ok' | 'fallback',
 *   reason: string,
 *   skill: string | null,
 *   route: 'cheap' | 'baseline',
 *   archetype: 'lookup' | 'json-transform' | 'formatting' | 'text-normalization' | 'none',
 *   confidence: number,
 *   model: string | null,
 *   usage: { inputTokens: number, outputTokens: number, costUsd: number, costKnown: boolean },
 *   skillConfidence?: number,
 *   routingConfidence?: number,
 *   eligibleScore?: number
 * }>}
 */
export async function decide({
  task,
  skills = [],
  apiKey,
  fetchImpl,
  signal,
  timeoutMs = 5000,
  model = DECISION_MODEL,
}) {
  const emptyUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: false };
  const fallback = (reason, mod = null, usg = emptyUsage) => ({
    status: "fallback",
    reason,
    skill: null,
    route: "baseline",
    archetype: "none",
    confidence: 0,
    model: mod,
    usage: {
      inputTokens: usg?.inputTokens || 0,
      outputTokens: usg?.outputTokens || 0,
      costUsd: usg?.costUsd || 0,
      costKnown: Boolean(usg?.costKnown),
    },
  });

  const screened = screenTask(task);
  if (!screened.allowed) {
    return fallback(`screened:${screened.reason}`);
  }

  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return fallback("missing-key");
  }

  const skillCriteria = {};
  if (Array.isArray(skills)) {
    for (const s of skills.slice(0, 254)) {
      if (s?.name && typeof s.name === "string") {
        skillCriteria[s.name.trim()] = String(s.description || s.name).slice(0, 500);
      }
    }
  }
  skillCriteria["none"] = "No skill is relevant or needed for this task";

  const requestBody = {
    model,
    state: {
      task: String(task).slice(0, 6000),
    },
    questions: {
      skill: {
        type: "choice",
        instructions: "Which skill should be opened to perform the task from the `task` field? Choose a skill only if the task directly falls within its purpose.",
        criteria: skillCriteria,
      },
      eligible: {
        type: "noul",
        instructions: "Is the task from `task` a self-contained, low-risk, safe leaf task eligible for cheap model routing?",
      },
      archetype: {
        type: "choice",
        instructions: "Which leaf task archetype best describes the task from `task`?",
        criteria: {
          lookup: "Simple search, grep, lookup, read, or status check",
          "json-transform": "Data manipulation, json parsing, filtering, remapping data structures",
          formatting: "Text formatting, linting, indentation, markdown layout, style fixes",
          "text-normalization": "Normalizing strings, text cleaning, unicode normalization, word casing",
          none: "None of the above or complex multi-file engineering task",
        },
      },
    },
  };

  const fetcher = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), Math.max(100, timeoutMs));

  const onCallerAbort = () => {
    try {
      controller.abort(signal.reason);
    } catch {}
  };

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return fallback("aborted");
    }
    try {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    } catch {}
  }

  try {
    const res = await fetcher(DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
        "User-Agent": "nullform-workflow/jev-assist",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!res || !res.ok) {
      return fallback(res ? `http-${res.status}` : "network-error");
    }

    let data;
    if (typeof res.text === "function") {
      const rawText = await res.text();
      if (typeof rawText !== "string" || rawText.length > 256 * 1024) {
        return fallback("invalid-response");
      }
      data = JSON.parse(rawText);
    } else if (typeof res.json === "function") {
      data = await res.json();
    } else {
      return fallback("invalid-response");
    }

    if (!data || typeof data !== "object") {
      return fallback("invalid-response");
    }

    // Model validation
    if (typeof data.model !== "string" || !data.model.trim()) {
      return fallback("invalid-response");
    }

    // Usage extraction and strict validation: missing/invalid tokens or cost rejects
    const rawUsage = data.usage;
    let usage = null;
    if (rawUsage && typeof rawUsage === "object") {
      const inTok = rawUsage.input_tokens ?? rawUsage.inputTokens;
      const outTok = rawUsage.output_tokens ?? rawUsage.outputTokens;
      const rawCost = rawUsage.cost ?? rawUsage.costUsd;

      const validIn = typeof inTok === "number" && Number.isFinite(inTok) && inTok >= 0;
      const validOut = typeof outTok === "number" && Number.isFinite(outTok) && outTok >= 0;
      const validCost = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0;

      if (validIn && validOut && validCost) {
        usage = {
          inputTokens: Math.floor(inTok),
          outputTokens: Math.floor(outTok),
          costUsd: rawCost,
          costKnown: true,
        };
      }
    }

    if (!usage) {
      return fallback("invalid-response", typeof data.model === "string" ? data.model : null);
    }
    // Answers validation
    const answers = data.answers;
    if (!answers || typeof answers !== "object") {
      return fallback("invalid-response", data.model, usage);
    }

    // 1. Skill question
    const skillAns = answers.skill;
    if (!skillAns || typeof skillAns !== "object") {
      return fallback("invalid-response", data.model, usage);
    }
    const rawSkillChoice = skillAns.choice;
    const rawSkillConf = skillAns.confidence;
    if (
      typeof rawSkillChoice !== "string" ||
      typeof rawSkillConf !== "number" ||
      !Number.isFinite(rawSkillConf) ||
      rawSkillConf < 0 ||
      rawSkillConf > 1
    ) {
      return fallback("invalid-response", data.model, usage);
    }
    // Reject invented skills
    if (rawSkillChoice !== "none" && !Object.prototype.hasOwnProperty.call(skillCriteria, rawSkillChoice)) {
      return fallback("invalid-response", data.model, usage);
    }
    const skillChoice = rawSkillChoice === "none" ? null : rawSkillChoice;

    // 2. Eligible question
    const eligibleAns = answers.eligible;
    if (!eligibleAns || typeof eligibleAns !== "object") {
      return fallback("invalid-response", data.model, usage);
    }
    const rawNoul = eligibleAns.noul;
    if (
      typeof rawNoul !== "number" ||
      !Number.isFinite(rawNoul) ||
      rawNoul < 0 ||
      rawNoul > 1
    ) {
      return fallback("invalid-response", data.model, usage);
    }

    // 3. Archetype question
    const archAns = answers.archetype;
    if (!archAns || typeof archAns !== "object") {
      return fallback("invalid-response", data.model, usage);
    }
    const rawArchetype = archAns.choice;
    const rawArchConf = archAns.confidence;
    if (
      typeof rawArchetype !== "string" ||
      !ALL_ARCHETYPES.has(rawArchetype) ||
      typeof rawArchConf !== "number" ||
      !Number.isFinite(rawArchConf) ||
      rawArchConf < 0 ||
      rawArchConf > 1
    ) {
      return fallback("invalid-response", data.model, usage);
    }

    // Routing resolution: independently conservative eligibility >= 0.95 and archetype confidence >= 0.90 for cheap
    const isEligible = rawNoul >= 0.95;
    const isLeaf = LEAF_ARCHETYPES.has(rawArchetype);
    const isArchConfident = rawArchConf >= 0.90;
    const route = isEligible && isLeaf && isArchConfident ? "cheap" : "baseline";

    // Skill confidence cannot substitute routing confidence
    const confidence = route === "cheap" ? rawArchConf : (skillChoice ? rawSkillConf : rawArchConf);

    return {
      status: "ok",
      reason: "ok",
      skill: skillChoice,
      route,
      archetype: rawArchetype,
      confidence,
      model: data.model,
      usage,
      skillConfidence: rawSkillConf,
      routingConfidence: rawArchConf,
      eligibleScore: rawNoul,
    };
  } catch (err) {
    const isTimeout = err?.name === "AbortError" || String(err?.message).includes("timeout");
    return fallback(isTimeout ? "timeout" : "network-error");
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === "function") {
      try {
        signal.removeEventListener("abort", onCallerAbort);
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Policy Fingerprint
// ---------------------------------------------------------------------------

/**
 * Computes deterministic policy fingerprint.
 * @param {{
 *   catalogFingerprint?: string,
 *   candidateModel?: string,
 *   baselineModel?: string,
 *   decisionModel?: string
 * }} params
 * @returns {string}
 */
export function policyFingerprint({
  catalogFingerprint = "",
  candidateModel = "",
  baselineModel = "",
  decisionModel = DECISION_MODEL,
}) {
  const norm = [
    String(catalogFingerprint || ""),
    String(candidateModel || ""),
    String(baselineModel || ""),
    String(decisionModel || DECISION_MODEL),
  ].join(":");
  return createHash("sha256").update(norm, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 7. Report Hurdle Evaluation
// ---------------------------------------------------------------------------

function extractJsonBlock(text) {
  if (typeof text !== "string") return text;
  const match = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  return match ? match[1].trim() : text.trim();
}

function sortJsonKeys(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortJsonKeys);
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = sortJsonKeys(obj[k]);
  }
  return out;
}

function normalizeText(text) {
  if (text === undefined || text === null) return "";
  return String(text).replace(/\r\n/g, "\n").trim();
}

function checkOutcomeMatch(actual, expected, type = "text") {
  if (actual === undefined || actual === null || expected === undefined || expected === null) return false;
  if (type === "json") {
    try {
      const a = typeof actual === "object" && actual !== null ? actual : JSON.parse(extractJsonBlock(String(actual)));
      const e = typeof expected === "object" && expected !== null ? expected : JSON.parse(typeof expected === "string" ? extractJsonBlock(expected) : expected);
      return JSON.stringify(sortJsonKeys(a)) === JSON.stringify(sortJsonKeys(e));
    } catch {
      return false;
    }
  }
  const normA = normalizeText(actual);
  const normE = normalizeText(expected);
  return normA === normE;
}

/**
 * Pure shared hurdle evaluation recomputing quality and cost thresholds
 * directly from complete raw case arrays without trusting superficial flags.
 * Enforces >=40 heldout skills cases, >=8 routing tasks, full finite nonnegative numeric fields,
 * consistent summaries, case counts, cost sums, dataset hashes, and fingerprints.
 * @param {unknown} report
 * @returns {{ skillPassed: boolean, routingPassed: boolean, archetypes: string[] }}
 */
export function evaluateReport(report) {
  const fail = { skillPassed: false, routingPassed: false, archetypes: [] };
  if (!report || typeof report !== "object") return fail;

  if (report.version !== 1 || report.completed !== true) return fail;
  if (report.dryRun === true || report.simulated === true) return fail;
  if (!Number.isInteger(report.errors) || report.errors !== 0) return fail;
  if (!Number.isInteger(report.requests) || report.requests <= 0) return fail;
  if (typeof report.spendUsd !== "number" || !Number.isFinite(report.spendUsd) || report.spendUsd < 0) return fail;
  if (typeof report.maxCostUsd !== "number" || !Number.isFinite(report.maxCostUsd) || report.maxCostUsd <= 0) return fail;
  if (report.spendUsd > report.maxCostUsd) return fail;
  const unknownSpendUsd = report.unknownSpendUsd ?? 0;
  if (typeof unknownSpendUsd !== "number" || !Number.isFinite(unknownSpendUsd) || unknownSpendUsd < 0) return fail;

  if (!Array.isArray(report.decisionSnapshots) || report.decisionSnapshots.length === 0) return fail;
  for (const snap of report.decisionSnapshots) {
    if (typeof snap !== "string" || !snap.trim()) return fail;
  }

  // Identity and fingerprint consistency
  if (
    typeof report.catalogFingerprint !== "string" ||
    typeof report.candidateModel !== "string" ||
    typeof report.baselineModel !== "string" ||
    typeof report.decisionModel !== "string" ||
    typeof report.fingerprint !== "string"
  ) {
    return fail;
  }
  const expectedFp = policyFingerprint({
    catalogFingerprint: report.catalogFingerprint,
    candidateModel: report.candidateModel,
    baselineModel: report.baselineModel,
    decisionModel: report.decisionModel,
  });
  if (report.fingerprint !== expectedFp) return fail;

  // Dataset hashes
  const dsHashes = report.datasetHashes;
  if (
    !dsHashes ||
    typeof dsHashes !== "object" ||
    typeof dsHashes.calibration !== "string" ||
    typeof dsHashes.heldout !== "string" ||
    typeof dsHashes.outcomes !== "string" ||
    !dsHashes.calibration.trim() ||
    !dsHashes.heldout.trim() ||
    !dsHashes.outcomes.trim()
  ) {
    return fail;
  }
  const isCalibCase = (c) => Boolean(
    c.isCalibration === true ||
    c.split === "calibration" ||
    (typeof c.id === "string" && c.id.startsWith("calib"))
  );

  // 1. Recompute skills hurdles
  const skills = report.skills;
  if (!skills || typeof skills !== "object" || !Array.isArray(skills.cases)) return fail;
  if (!Number.isInteger(skills.total) || skills.total !== skills.cases.length) return fail;

  const calibSkillsCases = [];
  const heldoutSkillsCases = [];
  const calibIds = new Set();
  const heldoutIds = new Set();

  for (const c of skills.cases) {
    if (!c || typeof c !== "object") return fail;
    const cid = typeof c.id === "string" ? c.id.trim() : "";
    if (!cid) return fail;
    if (isCalibCase(c)) {
      if (calibIds.has(cid)) return fail;
      calibIds.add(cid);
      calibSkillsCases.push(c);
    } else {
      if (heldoutIds.has(cid)) return fail;
      heldoutIds.add(cid);
      heldoutSkillsCases.push(c);
    }
  }

  // Calibration IDs and heldout IDs must have zero overlap
  for (const cid of calibIds) {
    if (heldoutIds.has(cid)) return fail;
  }

  // Explicit spec invariants: >= 12 calibration cases and >= 40 heldout cases
  if (calibSkillsCases.length < 12) return fail;
  if (heldoutSkillsCases.length < 40) return fail;

  if (
    !report.calibration ||
    typeof report.calibration !== "object" ||
    !Number.isInteger(report.calibration.total) ||
    report.calibration.total < 12 ||
    report.calibration.total !== calibSkillsCases.length
  ) {
    return fail;
  }
  if (
    !report.heldout ||
    typeof report.heldout !== "object" ||
    !Number.isInteger(report.heldout.total) ||
    report.heldout.total < 40 ||
    report.heldout.total !== heldoutSkillsCases.length
  ) {
    return fail;
  }
  const sBase = skills.baseline;
  const sCand = skills.candidate;
  if (!sBase || typeof sBase !== "object" || !sCand || typeof sCand !== "object") return fail;

  let safetyTotal = 0;
  let safetyMisses = 0;
  let criticalMisses = 0;
  let allSkillSafetyMisses = 0;
  let allSkillCriticalMisses = 0;
  let eligibleCount = 0;
  let baselineAttempted = 0;
  let baselineCorrect = 0;
  let baselineFP = 0;
  let candidateAttempted = 0;
  let candidateCorrect = 0;
  let candidateFP = 0;
  let computedBaselineCost = 0;
  let computedCandidateCost = 0;
  let globalKnownCost = 0;
  let computedRequests = 0;

  const parseCaseHeader = (c) => {
    if (
      !c ||
      typeof c !== "object" ||
      c.error ||
      typeof c.baselineCostUsd !== "number" ||
      !Number.isFinite(c.baselineCostUsd) ||
      c.baselineCostUsd < 0 ||
      typeof c.candidateCostUsd !== "number" ||
      !Number.isFinite(c.candidateCostUsd) ||
      c.candidateCostUsd < 0
    ) {
      return null;
    }
    return {
      cost: c.baselineCostUsd + c.candidateCostUsd,
      isSafety: Boolean(c.isSafety || c.kind === "safety"),
      isScreened: Boolean(c.screened),
    };
  };

  for (const c of skills.cases) {
    const header = parseCaseHeader(c);
    if (!header) return fail;
    globalKnownCost += header.cost;
    const { isSafety, isScreened } = header;

    if (typeof c.baselineRequested !== "boolean" || typeof c.candidateRequested !== "boolean") {
      return fail;
    }
    if ((isSafety || isScreened) && (c.baselineRequested || c.candidateRequested)) {
      return fail;
    }
    computedRequests += (c.baselineRequested ? 1 : 0) + (c.candidateRequested ? 1 : 0);

    const bAttempted = Boolean(c.baselineAttempted ?? (c.baselineSkill && c.baselineSkill !== "none"));
    const cAttempted =
      typeof c.skillConfidence === "number"
        ? Boolean(c.candidateAttempted && c.skillConfidence >= 0.80)
        : Boolean(c.candidateAttempted ?? (c.candidateSkill !== undefined && c.candidateSkill !== null));
    if (typeof c.candidateAttempted === "boolean" && c.candidateAttempted !== cAttempted) {
      return fail;
    }
    if ((bAttempted && !c.baselineRequested) || (cAttempted && !c.candidateRequested)) {
      return fail;
    }

    const rowSafetyMiss = Boolean(
      isSafety && (c.safetyMiss || cAttempted || (c.candidateSkill && c.candidateSkill !== "none"))
    );
    if (rowSafetyMiss) allSkillSafetyMisses++;
    if (c.criticalMiss) allSkillCriticalMisses++;
    // Recompute activation quality and decision cost only over non-calibration (heldout) cases
    if (!isCalibCase(c)) {
      computedBaselineCost += c.baselineCostUsd;
      computedCandidateCost += c.candidateCostUsd;

      if (isSafety) {
        safetyTotal++;
        if (rowSafetyMiss) safetyMisses++;
      } else {
        eligibleCount++;
      }

      if (c.criticalMiss) criticalMisses++;

      const expectedSet = new Set();
      if (Array.isArray(c.expectedSkills)) {
        for (const s of c.expectedSkills) {
          if (typeof s === "string" && s.trim()) expectedSet.add(s.trim());
        }
      } else if (typeof c.expectedSkill === "string" && c.expectedSkill.trim() && c.expectedSkill !== "none") {
        expectedSet.add(c.expectedSkill.trim());
      }
      const isExpectedNone = expectedSet.size === 0;

      if (bAttempted) {
        baselineAttempted++;
        const bSkill = c.baselineSkill && c.baselineSkill !== "none" ? c.baselineSkill : null;
        const bCorrect = isExpectedNone ? bSkill === null : (bSkill !== null && expectedSet.has(bSkill));
        if (bCorrect) baselineCorrect++;
        else if (isExpectedNone) baselineFP++;
      }

      if (cAttempted) {
        candidateAttempted++;
        const cSkill = c.candidateSkill && c.candidateSkill !== "none" ? c.candidateSkill : null;
        const cCorrect = isExpectedNone ? cSkill === null : (cSkill !== null && expectedSet.has(cSkill));
        if (cCorrect) candidateCorrect++;
        else if (isExpectedNone) candidateFP++;
      }
    }
  }

  // Strict consistency checks against heldout-only summaries and complete integer counts
  if (
    !Number.isInteger(skills.eligible) || skills.eligible !== eligibleCount ||
    !Number.isInteger(skills.safetyTotal) || skills.safetyTotal !== safetyTotal ||
    !Number.isInteger(skills.safetyMisses) || skills.safetyMisses !== safetyMisses ||
    !Number.isInteger(sBase.attempted) || sBase.attempted !== baselineAttempted ||
    !Number.isInteger(sBase.correct) || sBase.correct !== baselineCorrect ||
    (sBase.falsePositives !== undefined && (!Number.isInteger(sBase.falsePositives) || sBase.falsePositives !== baselineFP)) ||
    !Number.isInteger(sCand.attempted) || sCand.attempted !== candidateAttempted ||
    !Number.isInteger(sCand.correct) || sCand.correct !== candidateCorrect ||
    (sCand.falsePositives !== undefined && (!Number.isInteger(sCand.falsePositives) || sCand.falsePositives !== candidateFP)) ||
    !Number.isInteger(sCand.criticalMisses) || sCand.criticalMisses !== criticalMisses
  ) {
    return fail;
  }

  if (
    typeof sBase.costUsd !== "number" || !Number.isFinite(sBase.costUsd) ||
    Math.abs(Number(computedBaselineCost.toFixed(6)) - Number(sBase.costUsd.toFixed(6))) > 1e-6 ||
    typeof sCand.costUsd !== "number" || !Number.isFinite(sCand.costUsd) ||
    Math.abs(Number(computedCandidateCost.toFixed(6)) - Number(sCand.costUsd.toFixed(6))) > 1e-6
  ) {
    return fail;
  }

  const candidateCoverage = eligibleCount > 0 ? candidateAttempted / eligibleCount : 0;
  const candidatePrecision = candidateAttempted > 0 ? candidateCorrect / candidateAttempted : 0;
  const baselinePrecision = baselineAttempted > 0 ? baselineCorrect / baselineAttempted : 0;

  const skillPassed =
    allSkillSafetyMisses === 0 &&
    allSkillCriticalMisses === 0 &&
    candidateCoverage >= 0.7 &&
    candidatePrecision >= 0.95 &&
    candidatePrecision >= baselinePrecision &&
    (computedCandidateCost < computedBaselineCost || candidateCorrect > baselineCorrect);

  // 2. Recompute routing hurdles
  const routing = report.routing;
  if (!routing || typeof routing !== "object" || !Array.isArray(routing.cases)) return fail;
  if (routing.cases.length < 8) return fail;
  if (!Number.isInteger(routing.total) || routing.total !== routing.cases.length) return fail;

  const heldoutRoutingCases = routing.cases.filter((c) => !isCalibCase(c));
  if (heldoutRoutingCases.length < 8) return fail;
  const rBase = routing.baseline;
  const rCand = routing.candidate;
  if (!rBase || typeof rBase !== "object" || !rCand || typeof rCand !== "object") return fail;

  let routingSafetyTotal = 0;
  let routingSafetyMisses = 0;
  let allRoutingSafetyMisses = 0;
  let bPrimaryAccepted = 0;
  let cPrimaryAccepted = 0;
  let cRecoveryAccepted = 0;
  let rCostBaseline = 0;
  let rCostCandidate = 0;
  const evaluatedArchetypes = new Set();

  for (const c of routing.cases) {
    const header = parseCaseHeader(c);
    if (!header) return fail;
    globalKnownCost += header.cost;
    const { isSafety, isScreened } = header;
    if (
      typeof c.baselineRequested !== "boolean" ||
      typeof c.decisionRequested !== "boolean" ||
      typeof c.candidateRequested !== "boolean" ||
      typeof c.recoveryRequested !== "boolean"
    ) {
      return fail;
    }
    if (
      (isSafety || isScreened) &&
      (c.baselineRequested || c.decisionRequested || c.candidateRequested || c.recoveryRequested)
    ) {
      return fail;
    }
    computedRequests +=
      (c.baselineRequested ? 1 : 0) +
      (c.decisionRequested ? 1 : 0) +
      (c.candidateRequested ? 1 : 0) +
      (c.recoveryRequested ? 1 : 0);

    if (c.safetyMiss) allRoutingSafetyMisses++;

    const isPrimaryAttempted = c.candidatePrimaryAttempted === true;
    if (!isPrimaryAttempted) {
      // Reject missing/false primary-attempt claims even if fabricated accepted true
      if (c.candidatePrimaryAccepted === true || (c.candidateAccepted === true && !c.recoveryAccepted)) {
        return fail;
      }
    }
    if (
      (Boolean(c.baselineAttempted) && !c.baselineRequested) ||
      (isPrimaryAttempted && !c.candidateRequested) ||
      (Boolean(c.recoveryAccepted || c.recoveryAttempted) && !c.recoveryRequested)
    ) {
      return fail;
    }

    if (!isCalibCase(c)) {
      rCostBaseline += c.baselineCostUsd;
      rCostCandidate += c.candidateCostUsd;

      if (isSafety) routingSafetyTotal++;
      if (c.safetyMiss) routingSafetyMisses++;

      if (typeof c.archetype === "string" && LEAF_ARCHETYPES.has(c.archetype)) {
        evaluatedArchetypes.add(c.archetype);
      }

      let bAccepted = false;
      if (c.expected !== undefined && c.baselineOutput !== undefined) {
        bAccepted = checkOutcomeMatch(c.baselineOutput, c.expected, c.expectedType);
        if (typeof c.baselineAccepted === "boolean" && c.baselineAccepted !== bAccepted) {
          return fail;
        }
      } else {
        bAccepted = Boolean(c.baselineAccepted ?? c.baselineSuccess);
      }
      if (bAccepted) bPrimaryAccepted++;

      let cAccepted = false;
      if (isPrimaryAttempted) {
        if (c.expected !== undefined && c.candidatePrimaryOutput !== undefined) {
          cAccepted = checkOutcomeMatch(c.candidatePrimaryOutput, c.expected, c.expectedType);
          if (typeof c.candidatePrimaryAccepted === "boolean" && c.candidatePrimaryAccepted !== cAccepted) {
            return fail;
          }
        } else {
          cAccepted = Boolean(c.candidatePrimaryAccepted ?? (c.candidateAccepted && !c.recoveryAccepted));
        }
      }
      if (cAccepted) cPrimaryAccepted++;

      if (Boolean(c.recoveryAccepted)) cRecoveryAccepted++;
    }
  }

  // Strict consistency checks against routing summaries and complete integer counts
  if (
    (routing.safetyTotal !== undefined && (!Number.isInteger(routing.safetyTotal) || routing.safetyTotal !== routingSafetyTotal)) ||
    !Number.isInteger(routing.safetyMisses) || routing.safetyMisses !== routingSafetyMisses ||
    !Number.isInteger(rBase.primaryAccepted) || rBase.primaryAccepted !== bPrimaryAccepted ||
    !Number.isInteger(rCand.primaryAccepted) || rCand.primaryAccepted !== cPrimaryAccepted ||
    !Number.isInteger(rCand.recoveryAccepted) || rCand.recoveryAccepted !== cRecoveryAccepted
  ) {
    return fail;
  }

  if (
    typeof rBase.costUsd !== "number" || !Number.isFinite(rBase.costUsd) ||
    Math.abs(Number(rCostBaseline.toFixed(6)) - Number(rBase.costUsd.toFixed(6))) > 1e-6 ||
    typeof rCand.costUsd !== "number" || !Number.isFinite(rCand.costUsd) ||
    Math.abs(Number(rCostCandidate.toFixed(6)) - Number(rCand.costUsd.toFixed(6))) > 1e-6
  ) {
    return fail;
  }

  // Global request count and global spend (known + unknownSpendUsd) consistency
  if (report.requests !== computedRequests) return fail;
  const expectedGlobalSpend = Number((globalKnownCost + unknownSpendUsd).toFixed(6));
  if (Math.abs(Number(report.spendUsd.toFixed(6)) - expectedGlobalSpend) > 1e-6) return fail;

  const baselineCostPerAccepted = bPrimaryAccepted > 0 ? rCostBaseline / bPrimaryAccepted : Infinity;
  const candidateCostPerAccepted = cPrimaryAccepted > 0 ? rCostCandidate / cPrimaryAccepted : Infinity;

  const routingPassed =
    allRoutingSafetyMisses === 0 &&
    cPrimaryAccepted >= bPrimaryAccepted &&
    candidateCostPerAccepted < baselineCostPerAccepted &&
    evaluatedArchetypes.size > 0;

  const archetypes = routingPassed ? Array.from(evaluatedArchetypes).sort() : [];

  return {
    skillPassed,
    routingPassed,
    archetypes,
  };
}

// ---------------------------------------------------------------------------
// 8. Policy Verification
// ---------------------------------------------------------------------------

/**
 * Reads and cryptographically verifies policy against live report, exact identity, and catalog fingerprint.
 * Returns decisionSnapshots for runtime stale-checking.
 * @param {{ home: string, cwd?: string, fingerprint?: string }} options
 * @returns {{
 *   version: number,
 *   enabled: boolean,
 *   expiresAt: string,
 *   catalogFingerprint: string,
 *   candidateModel: string,
 *   baselineModel: string,
 *   decisionModel: string,
 *   fingerprint: string,
 *   skillPassed: boolean,
 *   routingPassed: boolean,
 *   reportSha256: string,
 *   archetypes: string[],
 *   decisionSnapshots: string[]
 * } | null}
 */
export function readPolicy({ home, cwd = process.cwd(), fingerprint } = {}) {
  if (!home || typeof home !== "string") return null;

  const optoutPaths = [
    join(home, ".omp", "agent", "jev-optout"),
    join(home, ".omp", "agent", ".jev-optout"),
    join(cwd, ".jev-optout"),
    join(cwd, ".workflow", "jev-optout"),
    join(cwd, ".omp", "agent", "jev-optout"),
  ];
  for (const p of optoutPaths) {
    if (existsSync(p)) return null;
  }
  if (process.env.JEV_OPTOUT === "1" || process.env.JEV_DISABLED === "1") {
    return null;
  }

  const policyPath = join(home, ".omp", "agent", "jev-policy.json");
  if (!existsSync(policyPath)) return null;

  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch {
    return null;
  }

  if (!policy || typeof policy !== "object") return null;
  if (policy.version !== 1 || policy.enabled !== true) return null;
  if (policy.decisionModel !== DECISION_MODEL) return null;

  const exp = new Date(policy.expiresAt).getTime();
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;

  const expectedFp = policyFingerprint({
    catalogFingerprint: policy.catalogFingerprint,
    candidateModel: policy.candidateModel,
    baselineModel: policy.baselineModel,
    decisionModel: policy.decisionModel,
  });
  if (policy.fingerprint !== expectedFp) return null;
  if (fingerprint && policy.fingerprint !== fingerprint) return null;

  if (!policy.reportSha256 || typeof policy.reportSha256 !== "string") return null;
  const reportPath = join(home, ".omp", "agent", "jev-evaluation.json");
  if (!existsSync(reportPath)) return null;

  let rawReport;
  let report;
  try {
    rawReport = readFileSync(reportPath, "utf8");
    const computedSha = createHash("sha256").update(rawReport, "utf8").digest("hex");
    if (computedSha !== policy.reportSha256) return null;
    report = JSON.parse(rawReport);
  } catch {
    return null;
  }

  if (
    report?.fingerprint !== policy.fingerprint ||
    report?.catalogFingerprint !== policy.catalogFingerprint ||
    report?.candidateModel !== policy.candidateModel ||
    report?.baselineModel !== policy.baselineModel ||
    report?.decisionModel !== policy.decisionModel
  ) {
    return null;
  }

  const evalResult = evaluateReport(report);
  const skillPassed = Boolean(policy.skillPassed && evalResult.skillPassed);
  const routingPassed = Boolean(policy.routingPassed && evalResult.routingPassed);

  if (!skillPassed && !routingPassed) return null;

  return {
    version: 1,
    enabled: true,
    expiresAt: policy.expiresAt,
    catalogFingerprint: policy.catalogFingerprint,
    candidateModel: policy.candidateModel,
    baselineModel: policy.baselineModel,
    decisionModel: DECISION_MODEL,
    fingerprint: policy.fingerprint,
    skillPassed,
    routingPassed,
    reportSha256: policy.reportSha256,
    archetypes: evalResult.archetypes,
    decisionSnapshots: Array.isArray(report.decisionSnapshots) ? report.decisionSnapshots : [],
    modelPrices: report.modelPrices || null,
  };
}

// ---------------------------------------------------------------------------
// 9. Redacted Event Telemetry
// ---------------------------------------------------------------------------

function redactText(text) {
  if (typeof text !== "string") return "";
  let out = text;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : pat.flags + "g"), "[REDACTED]");
  }
  for (const pat of PII_PATTERNS) {
    out = out.replace(new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : pat.flags + "g"), "[REDACTED]");
  }
  return out;
}

/**
 * Appends allow-listed aggregate session event to .workflow/jev-events.jsonl.
 * Validates and redacts string fields (model, reason, etc.) to prevent raw credential leakage.
 * @param {string} cwd
 * @param {Record<string, unknown>} event
 */
export function appendEvent(cwd, event) {
  if (!cwd || typeof cwd !== "string" || !event || typeof event !== "object") return;

  const record = {
    ts: typeof event.ts === "string" ? event.ts : new Date().toISOString(),
    event: typeof event.event === "string" ? redactText(event.event).slice(0, 64) : "unknown",
  };

  if (typeof event.route === "string") record.route = redactText(event.route).slice(0, 32);
  if (typeof event.skill === "string" || event.skill === null) {
    record.skill = event.skill === null ? null : redactText(event.skill).slice(0, 64);
  }
  if (typeof event.archetype === "string") record.archetype = redactText(event.archetype).slice(0, 32);
  if (typeof event.confidence === "number" && Number.isFinite(event.confidence)) {
    record.confidence = Math.round(event.confidence * 1000) / 1000;
  }
  if (typeof event.status === "string") record.status = redactText(event.status).slice(0, 32);
  if (typeof event.reason === "string") record.reason = redactText(event.reason).slice(0, 100);
  if (typeof event.inputTokens === "number" && Number.isFinite(event.inputTokens)) {
    record.inputTokens = Math.max(0, Math.floor(event.inputTokens));
  }
  if (typeof event.outputTokens === "number" && Number.isFinite(event.outputTokens)) {
    record.outputTokens = Math.max(0, Math.floor(event.outputTokens));
  }
  if (typeof event.costUsd === "number" && Number.isFinite(event.costUsd)) {
    record.costUsd = Math.max(0, event.costUsd);
  }
  if (typeof event.model === "string") record.model = redactText(event.model).slice(0, 64);
  if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) {
    record.durationMs = Math.max(0, Math.round(event.durationMs));
  }
  if (typeof event.sessionId === "string") record.sessionId = redactText(event.sessionId).slice(0, 64);
  if (typeof event.subagentRole === "string") record.subagentRole = redactText(event.subagentRole).slice(0, 64);
  if (typeof event.action === "string") record.action = redactText(event.action).slice(0, 64);

  try {
    const dir = join(cwd, ".workflow");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(join(dir, "jev-events.jsonl"), JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Non-fatal telemetry append
  }
}
