#!/usr/bin/env node
/**
 * lm-replay.mjs — record/replay LM transcripts as deterministic zero-cost cassettes.
 *
 * Format:
 *   {
 *     version: 1,
 *     model: string,
 *     recordedAt: string (ISO),
 *     turns: [
 *       {
 *         promptHash: string (sha256 of trimmed + whitespace-squeezed prompt),
 *         prompt: string,
 *         response: string,
 *         usage?: object,
 *         files?: object
 *       }
 *     ]
 *   }
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SECRET_BODY_KEYS = /("(?:api_?key|token|secret|password|access_?token|refresh_?token|signature|apiKey|apiSecret)"\s*:\s*")(?:\\.|[^"\\])*"/gi;
export const SECRET_QUERY = /([?&](?:api_?key|token|secret|password|signature|access_?token)=)[^&]*/gi;
export const SECRET_BEARER = /(Bearer\s+)[A-Za-z0-9_\-\.]{12,}/gi;
export const SECRET_PREFIXES = /\b(sk-[a-zA-Z0-9_\-]{16,}|ghp_[a-zA-Z0-9]{16,}|xox[baprs]-[a-zA-Z0-9]{16,})\b/g;
export const SECRET_KEY_ASSIGN = /((?:api_?key|token|secret|password|access_?token|refresh_?token|apiKey|apiSecret)\s*[:=]\s*["']?)(?!\[REDACTED\])[A-Za-z0-9_\-\.]{12,}(["']?)/gi;

export function normalizePrompt(prompt) {
  return String(prompt ?? "").trim().replace(/\s+/g, " ");
}

export function hashPrompt(prompt) {
  return createHash("sha256").update(normalizePrompt(prompt), "utf8").digest("hex");
}

export function hashRecordedPrompt(prompt) {
  return hashPrompt(redactText(prompt));
}
export function redactText(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(SECRET_BODY_KEYS, '$1[REDACTED]"')
    .replace(SECRET_QUERY, '$1[REDACTED]')
    .replace(SECRET_BEARER, '$1[REDACTED]')
    .replace(SECRET_PREFIXES, '[REDACTED]')
    .replace(SECRET_KEY_ASSIGN, '$1[REDACTED]$2');
}

export function redactUsage(usage) {
  if (!usage || typeof usage !== "object") return usage;
  try {
    const raw = JSON.stringify(usage);
    const redacted = redactText(raw);
    return JSON.parse(redacted);
  } catch {
    return usage;
  }
}

export function findUnredactedSecret(text) {
  if (typeof text !== "string") return null;
  const jsonMatch = /"(?:api_?key|token|secret|password|access_?token|refresh_?token|signature|apiSecret)"\s*:\s*"(?!\[REDACTED\])[^"]{12,}"/i.exec(text);
  if (jsonMatch) return jsonMatch[0].slice(0, 48);
  const bearerMatch = /Bearer\s+(?!\[REDACTED\])[A-Za-z0-9_\-\.]{12,}/i.exec(text);
  if (bearerMatch) return bearerMatch[0].slice(0, 48);
  const prefixMatch = /\b(sk-[a-zA-Z0-9_\-]{16,}|ghp_[a-zA-Z0-9]{16,}|xox[baprs]-[a-zA-Z0-9]{16,})\b/.exec(text);
  if (prefixMatch) return prefixMatch[0].slice(0, 48);
  const assignMatch = /(?:api_?key|token|secret|password|access_?token|refresh_?token|apiKey|apiSecret)\s*[:=]\s*["']?(?!\[REDACTED\])[A-Za-z0-9_\-\.]{12,}["']?/i.exec(text);
  if (assignMatch) return assignMatch[0].slice(0, 48);
  return null;
}

export function loadCassette(path) {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveCassette(path, cassette) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cassette, null, 2) + "\n", "utf8");
}

function extractMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
      .map((p) => p.text);
    if (textParts.length > 0) return textParts.join("\n");
    return JSON.stringify(content);
  }
  if (content && typeof content === "object") {
    return content.text || JSON.stringify(content);
  }
  return String(content ?? "");
}

function resolveTaskPrompt(taskId, root = ".") {
  if (!taskId) return null;
  try {
    const tasksPath = resolve(root, "bench", "tasks.json");
    if (existsSync(tasksPath)) {
      const data = JSON.parse(readFileSync(tasksPath, "utf8"));
      const t = (data.tasks || []).find((item) => item.id === taskId);
      if (t?.prompt) return t.prompt;
    }
  } catch {}
  return null;
}

function collectChangedFiles(repoDir, baseSha) {
  const files = {};
  if (!repoDir || !baseSha) return files;
  try {
    const readLines = (args) => {
      const res = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", windowsHide: true });
      return (res.stdout || "").split(/\r?\n/).filter(Boolean);
    };
    const targets = new Set([...readLines(["diff", "--name-only", baseSha]), ...readLines(["ls-files", "--others", "--exclude-standard"])]);
    for (const rel of targets) {
      const p = join(repoDir, rel);
      if (existsSync(p) && !statSync(p).isDirectory()) {
        files[rel] = readFileSync(p, "utf8");
      }
    }
  } catch {}
  return files;
}

function parseTurnsFromTranscript(from, taskId, overrides = {}) {
  let model = overrides.model || null;
  const rawTurns = [];

  if (typeof from === "string") {
    let target = from;
    if (existsSync(target) && statSync(target).isDirectory()) {
      for (const sub of ["session.jsonl", join("session", "session.jsonl")]) {
        const candidate = join(target, sub);
        if (existsSync(candidate)) { target = candidate; break; }
      }
    }

    if (existsSync(target)) {
      const content = readFileSync(target, "utf8").trim();
      try {
        const json = JSON.parse(content);
        if (Array.isArray(json?.turns)) return { model: json.model || model, turns: json.turns };
        if (Array.isArray(json)) return { model, turns: json.filter((i) => i.prompt && i.response) };
      } catch {}

      const lines = content.split(/\r?\n/).filter(Boolean);
      let curPrompt = overrides.prompt || null;
      let lastResp = overrides.response || null;
      let lastUsage = overrides.usage || null;

      for (const line of lines) {
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || typeof ev !== "object") continue;
        if (ev.type === "session_start" && ev.selector) model = model || ev.selector;
        else if (ev.type === "model_change") model = ev.model || ev.to || model;
        else if (ev.type === "message" || ev.role) {
          const m = ev.message || ev;
          if (m.model) model = model || m.model;
          if (m.role === "user") curPrompt = extractMessageContent(m.content);
          else if (m.role === "assistant") {
            const resp = extractMessageContent(m.content);
            const u = m.usage || null;
            if (curPrompt) {
              rawTurns.push({ prompt: curPrompt, response: resp, usage: u });
              curPrompt = null;
            } else {
              lastResp = resp;
              lastUsage = u;
            }
          }
        }
      }

      if (rawTurns.length === 0 && lastResp) {
        const fallbackPrompt = curPrompt || overrides.prompt || resolveTaskPrompt(taskId) || "";
        rawTurns.push({ prompt: fallbackPrompt, response: lastResp, usage: lastUsage });
      }
    }
  } else if (from && typeof from === "object") {
    if (Array.isArray(from.turns)) return { model: from.model || model, turns: from.turns };
    if (from.prompt && from.response) rawTurns.push(from);
  }

  if (rawTurns.length === 0 && overrides.prompt && overrides.response) {
    rawTurns.push({
      prompt: overrides.prompt,
      response: overrides.response,
      usage: overrides.usage,
      files: overrides.files,
    });
  }

  return { model, turns: rawTurns };
}

export function recordCassette(options) {
  const { taskId, from, out, model: modelOverride, prompt, response, usage, files } = options;
  const parsed = parseTurnsFromTranscript(from, taskId, {
    model: modelOverride,
    prompt,
    response,
    usage,
    files,
  });

  if (parsed.turns.length === 0) {
    throw new Error(`lm-replay: no turns found in source (${from})`);
  }

  const finalTurns = parsed.turns.map((turn) => {
    const cleanPrompt = redactText(turn.prompt || "");
    const cleanResponse = redactText(turn.response || "");
    const cleanUsage = redactUsage(turn.usage || { input: 0, output: 0, cost: { total: 0 } });
    return {
      promptHash: hashRecordedPrompt(cleanPrompt),
      prompt: cleanPrompt,
      response: cleanResponse,
      usage: cleanUsage,
      ...(turn.files || files ? { files: turn.files || files } : {}),
    };
  });

  const cassette = {
    version: 1,
    model: parsed.model || modelOverride || "unknown",
    recordedAt: new Date().toISOString(),
    turns: finalTurns,
  };

  if (out) saveCassette(out, cassette);
  return cassette;
}

export function replayCassette(cassettePathOrObj, prompt, { strict = false } = {}) {
  const cassette =
    typeof cassettePathOrObj === "string" ? loadCassette(cassettePathOrObj) : cassettePathOrObj;
  if (!cassette) {
    throw new Error(`lm-replay: failed to load cassette from ${cassettePathOrObj}`);
  }
  const targetHash = hashRecordedPrompt(prompt);
  const turn = (cassette.turns || []).find((t) => t.promptHash === targetHash);
  if (turn) {
    return {
      hit: true,
      turn,
      response: turn.response,
      usage: turn.usage || { input: 0, output: 0, cost: { total: 0 } },
      files: turn.files || null,
    };
  }
  if (strict) {
    const err = new Error(`lm-replay: STALE prompt drift (hash: ${targetHash})`);
    err.code = "STALE";
    err.promptHash = targetHash;
    err.exitCode = 1;
    throw err;
  }
  return {
    hit: false,
    promptHash: targetHash,
  };
}

export function verifyCassette(cassettePath) {
  const cassette = loadCassette(cassettePath);
  if (!cassette) {
    console.error(`lm-replay: no cassette at ${cassettePath}`);
    return 2;
  }

  const problems = [];
  if (cassette.version !== 1) problems.push(`unexpected version ${cassette.version}`);
  if (!cassette.model || typeof cassette.model !== "string") problems.push("missing or invalid model");
  if (!cassette.recordedAt) problems.push("missing recordedAt");
  if (!Array.isArray(cassette.turns)) {
    problems.push("turns is not an array");
  } else if (cassette.turns.length === 0) {
    problems.push("cassette has no turns — it proves nothing");
  } else {
    for (const [n, turn] of cassette.turns.entries()) {
      if (typeof turn.prompt !== "string") problems.push(`turn ${n}: missing prompt`);
      if (typeof turn.response !== "string") problems.push(`turn ${n}: missing response`);
      if (!turn.promptHash) {
        problems.push(`turn ${n}: missing promptHash`);
      } else if (typeof turn.prompt === "string") {
        const expectedHash = hashRecordedPrompt(turn.prompt);
        if (turn.promptHash !== expectedHash) {
          problems.push(`turn ${n}: promptHash mismatch (got ${turn.promptHash}, expected ${expectedHash})`);
        }
      }

      for (const [where, val] of [
        ["prompt", turn.prompt],
        ["response", turn.response],
        ["usage", turn.usage ? JSON.stringify(turn.usage) : null],
      ]) {
        if (typeof val === "string") {
          const leak = findUnredactedSecret(val);
          if (leak) problems.push(`turn ${n}: UNREDACTED SECRET in ${where} -> ${leak}`);
        }
      }

      if (turn.files && typeof turn.files === "object") {
        for (const [filename, content] of Object.entries(turn.files)) {
          if (typeof content === "string") {
            const leak = findUnredactedSecret(content);
            if (leak) problems.push(`turn ${n}: UNREDACTED SECRET in files[${filename}] -> ${leak}`);
          }
        }
      }
    }
  }
  if (problems.length === 0) {
    console.log(`lm-replay: cassette ${cassettePath}`);
    console.log(`  model       ${cassette.model}`);
    console.log(`  recordedAt  ${cassette.recordedAt}`);
    console.log(`  turns       ${(cassette.turns || []).length}`);
    console.log("\n  cassette is structurally valid and redacted.");
    return 0;
  }

  console.log(`lm-replay: cassette ${cassettePath}`);
  console.log(`\n  ${problems.length} problem(s):`);
  for (const p of problems) console.log(`    ${p}`);
  return 1;
}

export function recordBenchmarkRun({
  out,
  absRoot,
  prompt,
  response,
  repoDir,
  baseSha,
  cost,
  arm,
}) {
  if (!out) return;
  const outPath = isAbsolute(out) ? out : resolve(absRoot || ".", out);
  const files = collectChangedFiles(repoDir, baseSha);
  const cleanPrompt = redactText(prompt || "");
  const cleanResponse = redactText(response || "");
  const promptHash = hashRecordedPrompt(cleanPrompt);
  const usage = cost ? { cost } : { input: 0, output: 0, cost: { total: 0 } };

  const cassette = {
    version: 1,
    model: arm || "recorded",
    recordedAt: new Date().toISOString(),
    turns: [
      {
        promptHash,
        prompt: cleanPrompt,
        response: cleanResponse,
        usage: redactUsage(usage),
        ...(Object.keys(files).length > 0 ? { files } : {}),
      },
    ],
  };

  saveCassette(outPath, cassette);
  return cassette;
}

export function executeReplayTurn({ replay, absRoot, prompt, repoDir }) {
  const absCassettePath = isAbsolute(replay) ? replay : resolve(absRoot, replay);
  if (!existsSync(absCassettePath)) {
    throw new Error(`Кассета не найдена: ${replay}`);
  }
  const hit = replayCassette(absCassettePath, prompt, { strict: true });
  if (hit.files) {
    for (const [relPath, content] of Object.entries(hit.files)) {
      const dest = join(repoDir, relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content, "utf8");
    }
  }
  return {
    stdout: hit.response || "",
    stderr: "",
    exitCode: 0,
    status: "ok",
  };
}

export function cmdRecord({ task, from, out, model }) {
  if (!from) {
    console.error("lm-replay: missing --from");
    return 2;
  }
  if (!out) {
    console.error("lm-replay: missing --out");
    return 2;
  }
  try {
    const cassette = recordCassette({ taskId: task, from, out, model });
    console.log(`lm-replay: recorded cassette to ${out} (${cassette.turns.length} turn(s))`);
    return 0;
  } catch (err) {
    console.error(`lm-replay record failed: ${err.message}`);
    return 1;
  }
}

export function cmdReplay({ cassette: cassettePath, prompt: promptArg, strict = false }) {
  if (!cassettePath) {
    console.error("lm-replay: missing --cassette");
    return 2;
  }
  if (!promptArg) {
    console.error("lm-replay: missing --prompt");
    return 2;
  }
  const promptText = promptArg.startsWith("@")
    ? readFileSync(promptArg.slice(1), "utf8")
    : promptArg;
  const cassette = loadCassette(cassettePath);
  if (!cassette) {
    console.error(`lm-replay: cassette not found at ${cassettePath}`);
    return 2;
  }
  try {
    const res = replayCassette(cassette, promptText, { strict });
    if (res.hit) {
      process.stdout.write(res.response);
      return 0;
    }
    console.error(`lm-replay: STALE prompt drift (hash: ${res.promptHash})`);
    return 1;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

export function cmdVerify(cassettePath) {
  if (!cassettePath) {
    console.error("lm-replay: missing --cassette");
    return 2;
  }
  return verifyCassette(cassettePath);
}

export function parseArgs(argv) {
  const args = {
    command: null,
    task: null,
    from: null,
    out: null,
    model: null,
    cassette: null,
    prompt: null,
    strict: false,
    help: false,
    _: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--task") args.task = argv[++i];
    else if (arg.startsWith("--task=")) args.task = arg.slice(7);
    else if (arg === "--from") args.from = argv[++i];
    else if (arg.startsWith("--from=")) args.from = arg.slice(7);
    else if (arg === "--out") args.out = argv[++i];
    else if (arg.startsWith("--out=")) args.out = arg.slice(6);
    else if (arg === "--model") args.model = argv[++i];
    else if (arg.startsWith("--model=")) args.model = arg.slice(8);
    else if (arg === "--cassette") args.cassette = argv[++i];
    else if (arg.startsWith("--cassette=")) args.cassette = arg.slice(11);
    else if (arg === "--prompt") args.prompt = argv[++i];
    else if (arg.startsWith("--prompt=")) args.prompt = arg.slice(9);
    else if (!arg.startsWith("-")) {
      if (!args.command) args.command = arg;
      else args._.push(arg);
    }
  }
  return args;
}

function printUsage() {
  console.log(`lm-replay.mjs — record/replay LM transcripts as deterministic cassettes

Использование:
  node tools/lm-replay.mjs record --task <id> --from <transcript> --out <cassette>
  node tools/lm-replay.mjs replay --cassette <file> --prompt <text|@file> [--strict]
  node tools/lm-replay.mjs verify --cassette <file>

Команды:
  record     Собрать кассету из сессии/транскрипта с автоматической очисткой секретов
  replay     Воспроизвести записанный ответ по хешу промпта ($0)
  verify     Проверить валидность структуры кассеты и отсутствие незамаскированных секретов
`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.command) {
    printUsage();
    return 0;
  }

  switch (args.command) {
    case "record":
      return cmdRecord(args);
    case "replay":
      return cmdReplay(args);
    case "verify":
      return cmdVerify(args.cassette || args._[0]);
    default:
      console.error(`lm-replay: unknown command '${args.command}'`);
      printUsage();
      return 2;
  }
}

const isMain = process.argv[1] && (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exitCode = main();
}
