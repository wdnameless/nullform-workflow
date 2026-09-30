import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { policyFingerprint, evaluateReport, loadEvaluationDatasetContext } from "./jev-evidence.mjs";

const DECISION_MODEL = "typesafe/jev-1.13";
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const LEAF_ARCHETYPES = new Set(["lookup", "json-transform", "formatting", "text-normalization"]);
const ALL_ARCHETYPES = new Set(["lookup", "json-transform", "formatting", "text-normalization", "none"]);

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

const SECRET_PATTERNS = [
  /sk-(?:or-v1-)?[A-Za-z0-9_-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9_]{59}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bAIza[0-9A-Za-z-_]{35}\b/,
  /\bxox[baprs]-[0-9A-Za-z-_]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]+\b/,
  /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/,
  /(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /(?<=^|[^\p{L}\p{N}_])(?:(?:[a-zA-Z0-9_]*_)?(?:secret[_-]?access[_-]?key|session[_-]?token|access[_-]?key(?:[_-]?id)?|api[_-]?key|api[_-]?secret|client[_-]?secret|secret[_-]?key|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|bearer|credential|пароль|токен))["'`]?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;"'`]+)/iu,
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

function hasRawSecretOrPii(text) {
  if (typeof text !== "string") return false;
  return SECRET_PATTERNS.some((pat) => pat.test(text)) || PII_PATTERNS.some((pat) => pat.test(text));
}

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

export function screenTask(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { allowed: false, reason: "empty-task" };
  }

  const trimmed = text.trim();

  if (trimmed.length > 8000) {
    return { allowed: false, reason: "overlong" };
  }

  for (const pat of PII_PATTERNS) {
    if (pat.test(trimmed)) return { allowed: false, reason: "pii" };
  }
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(trimmed)) return { allowed: false, reason: "secret" };
  }
  if (/```[\s\S]*?```/.test(trimmed)) {
    for (const block of trimmed.match(/```[\s\S]*?```/g) || []) {
      if (block.split("\n").length > 15 || block.length > 800) {
        return { allowed: false, reason: "code-dump" };
      }
    }
  }
  for (const pat of CODE_DUMP_PATTERNS) {
    if (pat.test(trimmed)) return { allowed: false, reason: "code-dump" };
  }
  for (const pat of CONTINUATION_PATTERNS) {
    if (pat.test(trimmed)) return { allowed: false, reason: "context-only" };
  }
  for (const pat of RISKY_PATTERNS) {
    if (pat.test(trimmed)) return { allowed: false, reason: "risky" };
  }
  return { allowed: true, reason: "ok" };
}

function buildDecisionRequest(task, skills, model) {
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

  return { skillCriteria, requestBody };
}

function parseUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const inTok = rawUsage.input_tokens ?? rawUsage.inputTokens;
  const outTok = rawUsage.output_tokens ?? rawUsage.outputTokens;
  const rawCost = rawUsage.cost ?? rawUsage.costUsd;

  const validIn = typeof inTok === "number" && Number.isFinite(inTok) && inTok >= 0;
  const validOut = typeof outTok === "number" && Number.isFinite(outTok) && outTok >= 0;
  const validCost = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0;

  if (validIn && validOut && validCost) {
    return {
      inputTokens: Math.floor(inTok),
      outputTokens: Math.floor(outTok),
      costUsd: rawCost,
      costKnown: true,
    };
  }
  return null;
}

function validateAnswers(answers, skillCriteria) {
  if (!answers || typeof answers !== "object") return null;

  const skillAns = answers.skill;
  if (!skillAns || typeof skillAns !== "object") return null;
  const rawSkillChoice = skillAns.choice;
  const rawSkillConf = skillAns.confidence;
  if (
    typeof rawSkillChoice !== "string" ||
    typeof rawSkillConf !== "number" ||
    !Number.isFinite(rawSkillConf) ||
    rawSkillConf < 0 ||
    rawSkillConf > 1
  ) {
    return null;
  }
  if (rawSkillChoice !== "none" && !Object.prototype.hasOwnProperty.call(skillCriteria, rawSkillChoice)) {
    return null;
  }
  const skillChoice = rawSkillChoice === "none" ? null : rawSkillChoice;

  const eligibleAns = answers.eligible;
  if (!eligibleAns || typeof eligibleAns !== "object") return null;
  const rawNoul = eligibleAns.noul;
  if (
    typeof rawNoul !== "number" ||
    !Number.isFinite(rawNoul) ||
    rawNoul < 0 ||
    rawNoul > 1
  ) {
    return null;
  }

  const archAns = answers.archetype;
  if (!archAns || typeof archAns !== "object") return null;
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
    return null;
  }

  return {
    skillChoice,
    rawSkillConf,
    rawNoul,
    rawArchetype,
    rawArchConf,
  };
}

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

  const { skillCriteria, requestBody } = buildDecisionRequest(task, skills, model);
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

    if (!data || typeof data !== "object" || typeof data.model !== "string" || !data.model.trim()) {
      return fallback("invalid-response");
    }

    const usage = parseUsage(data.usage);
    if (!usage) {
      return fallback("invalid-response", data.model);
    }

    const validated = validateAnswers(data.answers, skillCriteria);
    if (!validated) {
      return fallback("invalid-response", data.model, usage);
    }

    const { skillChoice, rawSkillConf, rawNoul, rawArchetype, rawArchConf } = validated;
    const isEligible = rawNoul >= 0.95;
    const isLeaf = LEAF_ARCHETYPES.has(rawArchetype);
    const isArchConfident = rawArchConf >= 0.90;
    const route = isEligible && isLeaf && isArchConfident ? "cheap" : "baseline";
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

  const datasetContext = loadEvaluationDatasetContext({ root: cwd });
  if (!datasetContext) return null;
  const evalResult = evaluateReport(report, { datasetContext });
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

export function appendEvent(cwd, event) {
  if (!cwd || typeof cwd !== "string" || !event || typeof event !== "object") return;
  const record = {
    ts: typeof event.ts === "string" ? event.ts : new Date().toISOString(),
    event: typeof event.event === "string" ? redactText(event.event).slice(0, 64) : "unknown",
  };
  const strFields = [["route", 32], ["archetype", 32], ["status", 32], ["model", 64], ["sessionId", 64], ["subagentRole", 64], ["action", 64]];
  for (const [key, maxLen] of strFields) {
    if (typeof event[key] === "string") record[key] = redactText(event[key]).slice(0, maxLen);
  }
  if (typeof event.skill === "string" || event.skill === null) {
    record.skill = event.skill === null ? null : redactText(event.skill).slice(0, 64);
  }
  if (typeof event.reason === "string") record.reason = redactText(event.reason).slice(0, 100);
  if (typeof event.confidence === "number" && Number.isFinite(event.confidence)) {
    record.confidence = Math.round(event.confidence * 1000) / 1000;
  }
  for (const numKey of ["inputTokens", "outputTokens"]) {
    if (typeof event[numKey] === "number" && Number.isFinite(event[numKey])) {
      record[numKey] = Math.max(0, Math.floor(event[numKey]));
    }
  }
  if (typeof event.costUsd === "number" && Number.isFinite(event.costUsd)) {
    record.costUsd = Math.max(0, event.costUsd);
  }
  if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) {
    record.durationMs = Math.max(0, Math.round(event.durationMs));
  }
  try {
    const dir = join(cwd, ".workflow");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "jev-events.jsonl"), JSON.stringify(record) + "\n", "utf8");
  } catch {}
}
