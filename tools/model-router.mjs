#!/usr/bin/env node
/**
 * tools/model-router.mjs
 *
 * Model category autorouter and resolver per interfaces.md §T1 (R01+R02).
 * - resolveCategory: walks chain, skips unavailable models, stops with MODEL_STOP_QUESTION.
 * - scanProviders / --scan: probes providers via probeProvider -> JSON.
 * - planCategories / --plan: heuristic category assignment -> print plan.
 * - applyCategories / --apply --yes: writes categories to models.yml (refuses without --yes).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs as utilParseArgs } from "node:util";
import yaml from "yaml";
import { probeProvider } from "./oracle-model.mjs";

export const MODEL_STOP_QUESTION = "MODEL_STOP_QUESTION";

export class ModelStopQuestionError extends Error {
  constructor(message = MODEL_STOP_QUESTION, details = {}) {
    super(message);
    this.name = "ModelStopQuestionError";
    this.code = MODEL_STOP_QUESTION;
    this.details = details;
  }
}

export const ROLE_TO_CATEGORY = Object.freeze({
  oracle: "strict",
  reviewer: "strict",
  orchestrator: "strict",
  fixer: "builder",
  designer: "builder",
  explorer: "scout",
  scout: "scout",
  sonic: "scout",
  librarian: "scout",
});

export const DEFAULT_EFFORTS = Object.freeze({
  strict: "high",
  builder: "medium",
  scout: "low",
});

export function parseCliArgs(argv) {
  const { values } = utilParseArgs({
    args: argv,
    options: {
      scan: { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      models: { type: "string" },
      probe: { type: "boolean", default: false },
      "probe-file": { type: "string" },
      "probe-json": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  return values;
}

export function printHelp() {
  console.log(`Usage: node tools/model-router.mjs [options]

Model category autorouter and resolver.

Options:
  --scan              Probe all declared providers and output JSON {provider: [ids] | error}
  --plan              Compute category assignments using heuristics and print without writing
  --apply             Write proposed categories to models.yml (requires --yes)
  --yes               Explicit approval required for --apply
  --models <path>     Path to models.yml (default: agent/models.yml or ~/.omp/agent/models.yml)
  --probe             Perform live HTTP probe during --plan
  --probe-file <file> Load pre-probed provider results JSON (for offline / test use)
  --probe-json <json> Load pre-probed provider results JSON string
  -h, --help          Show this help message and exit
`);
}

export function resolveModelsPath(explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  const cwdModels = resolve("agent/models.yml");
  if (existsSync(cwdModels)) return cwdModels;
  const homeModels = join(homedir(), ".omp", "agent", "models.yml");
  if (existsSync(homeModels)) return homeModels;
  return cwdModels;
}

export function classifyModel(modelId, { reasoning = false } = {}) {
  const id = String(modelId || "");
  if (/(?<!ge)mini|flash|lite|haiku/i.test(id)) {
    return "scout";
  }
  if (reasoning === true || /opus|pro|max/i.test(id)) {
    return "strict";
  }
  return "builder";
}

export function loadModelsConfig(modelsInput) {
  if (!modelsInput) return {};
  if (typeof modelsInput === "object") return modelsInput;
  if (typeof modelsInput === "string") {
    if (existsSync(modelsInput)) {
      try {
        const text = readFileSync(modelsInput, "utf8");
        return yaml.parse(text) || {};
      } catch (err) {
        throw new Error(`Failed to read models file ${modelsInput}: ${err.message}`);
      }
    }
    if (/\.(ya?ml)$/i.test(modelsInput.trim())) {
      throw new Error(`models file not found: ${modelsInput}`);
    }
    try {
      return yaml.parse(modelsInput) || {};
    } catch {
      return {};
    }
  }
  return {};
}

export function parseChainItem(rawItem) {
  if (typeof rawItem === "string") {
    const slash = rawItem.indexOf("/");
    if (slash === -1) return { provider: rawItem, model: "" };
    return { provider: rawItem.slice(0, slash), model: rawItem.slice(slash + 1) };
  }
  if (rawItem && typeof rawItem === "object") {
    if (rawItem.provider && rawItem.model) {
      return { provider: String(rawItem.provider), model: String(rawItem.model) };
    }
    if (rawItem.qualified && typeof rawItem.qualified === "string") {
      return parseChainItem(rawItem.qualified);
    }
  }
  return { provider: "", model: "" };
}

function matchesFilterCollection(collection, qualified, model) {
  if (!collection) return false;
  return Boolean(
    collection.has?.(qualified) ||
    collection.includes?.(qualified) ||
    collection.has?.(model) ||
    collection.includes?.(model)
  );
}

function checkFilterOptionOverrides(provider, model, options) {
  const qualified = `${provider}/${model}`;
  if (typeof options.isUnavailable === "function" && options.isUnavailable(provider, model)) {
    return false;
  }
  if (typeof options.isAvailable === "function" && !options.isAvailable(provider, model)) {
    return false;
  }
  if (matchesFilterCollection(options.unavailable, qualified, model)) {
    return false;
  }
  if (options.available && !matchesFilterCollection(options.available, qualified, model)) {
    return false;
  }
  return true;
}

function isProbeResultMissingModel(provProbe, model) {
  if (typeof provProbe === "string") return true;
  if (!provProbe) return false;
  if (provProbe.error || provProbe.reachable === false) return true;
  if (Array.isArray(provProbe)) return !provProbe.includes(model);
  if (Array.isArray(provProbe.models)) return !provProbe.models.includes(model);
  return false;
}

function checkProbeCache(provider, model, models, options) {
  const cache = options.probeCache || options.probeResults || models._probeCache || models.probeCache;
  if (!cache || typeof cache !== "object") return true;
  const provProbe = cache[provider];
  if (provProbe === undefined) return true;
  return !isProbeResultMissingModel(provProbe, model);
}

function checkProviderDeclaredModel(provDef, model) {
  if (!provDef) return true;
  if (provDef.reachable === false || provDef.disabled === true || provDef.available === false || provDef.error) {
    return false;
  }
  if (!Array.isArray(provDef.models)) return true;
  for (const m of provDef.models) {
    if (typeof m === "object" && m !== null && m.id === model) {
      if (m.available === false || m.disabled === true) return false;
    }
  }
  return true;
}

export function isModelAvailable(provider, model, models = {}, options = {}) {
  if (!checkFilterOptionOverrides(provider, model, options)) return false;
  if (!checkProbeCache(provider, model, models, options)) return false;
  return checkProviderDeclaredModel(models.providers?.[provider], model);
}

export function resolveCategory(category, modelsYml, options = {}) {
  const models = loadModelsConfig(modelsYml);
  const targetCategory = ROLE_TO_CATEGORY[category] || category;

  const categories = models.categories;
  if (!categories || typeof categories !== "object") {
    throw new ModelStopQuestionError(MODEL_STOP_QUESTION, {
      category: targetCategory,
      reason: "No categories defined in models configuration",
    });
  }

  const catConfig = categories[targetCategory] || categories[category];
  if (!catConfig || !Array.isArray(catConfig.chain) || catConfig.chain.length === 0) {
    throw new ModelStopQuestionError(MODEL_STOP_QUESTION, {
      category: targetCategory,
      reason: `Chain for category '${targetCategory}' is empty or missing`,
    });
  }

  for (const rawItem of catConfig.chain) {
    const { provider, model } = parseChainItem(rawItem);
    if (!provider || !model) continue;

    if (isModelAvailable(provider, model, models, options)) {
      const effort = catConfig.effort || DEFAULT_EFFORTS[targetCategory] || "medium";
      return { provider, model, effort };
    }
  }

  throw new ModelStopQuestionError(MODEL_STOP_QUESTION, {
    category: targetCategory,
    reason: `All models in chain for category '${targetCategory}' are unavailable`,
  });
}

export async function scanProviders(modelsInput, { probeRunner = probeProvider } = {}) {
  const models = loadModelsConfig(modelsInput);
  const providers = models.providers || {};
  const scanResults = {};

  for (const [provName, provDef] of Object.entries(providers)) {
    const prov = { name: provName, ...provDef };
    if (!prov.baseUrl) {
      scanResults[provName] = "Missing baseUrl";
      continue;
    }
    try {
      const res = await probeRunner(prov);
      if (res && res.error) {
        scanResults[provName] = res.error;
      } else {
        scanResults[provName] = (res && Array.isArray(res.models)) ? res.models : [];
      }
    } catch (err) {
      scanResults[provName] = err.message || "Probe failed";
    }
  }

  return scanResults;
}

function buildCategoryChain(matchedList, allCandidates) {
  if (allCandidates.length === 0) return [];
  const primary = matchedList[0] || allCandidates[0];
  const primaryQualified = `${primary.provider}/${primary.id}`;

  const chain = [primaryQualified];
  const seen = new Set([primaryQualified]);

  const add = (m) => {
    const q = `${m.provider}/${m.id}`;
    if (!seen.has(q)) {
      seen.add(q);
      chain.push(q);
    }
  };

  for (const m of matchedList.slice(1)) add(m);
  for (const m of allCandidates) {
    if (m.provider === primary.provider) add(m);
  }
  for (const m of allCandidates) add(m);

  return chain;
}

function findDeclaredReasoning(provDef, modelId) {
  const declared = (provDef.models || []).find((m) => {
    const id = typeof m === "string" ? m : m?.id;
    return id === modelId;
  });
  return Boolean(declared?.reasoning);
}

function extractProbedCandidates(provName, provDef, probedList) {
  const result = [];
  for (const modelId of probedList) {
    const reasoning = findDeclaredReasoning(provDef, modelId);
    result.push({ provider: provName, id: String(modelId), reasoning });
  }
  return result;
}

function extractDeclaredCandidates(provName, provDef) {
  const result = [];
  if (!Array.isArray(provDef.models)) return result;
  for (const m of provDef.models) {
    const id = typeof m === "string" ? m : m?.id;
    if (id) {
      const reasoning = Boolean(typeof m === "object" && m?.reasoning);
      result.push({ provider: provName, id: String(id), reasoning });
    }
  }
  return result;
}

function collectProviderCandidates(provName, provDef, resolvedProbe) {
  if (!resolvedProbe) {
    return extractDeclaredCandidates(provName, provDef);
  }
  const probed = resolvedProbe[provName];
  if (typeof probed === "string") {
    return [];
  }
  if (Array.isArray(probed)) {
    return extractProbedCandidates(provName, provDef, probed);
  }
  return extractDeclaredCandidates(provName, provDef);
}

function collectAllCandidateModels(providers, resolvedProbe) {
  const candidates = [];
  for (const [provName, provDef] of Object.entries(providers)) {
    candidates.push(...collectProviderCandidates(provName, provDef, resolvedProbe));
  }
  return candidates;
}

export async function planCategories(modelsInput, { probeResults = null, probeRunner = null, probe = false } = {}) {
  const models = loadModelsConfig(modelsInput);
  const providers = models.providers || {};

  let resolvedProbe = probeResults;
  if (!resolvedProbe && probe && probeRunner) {
    resolvedProbe = await scanProviders(models, { probeRunner });
  }

  const candidateModels = collectAllCandidateModels(providers, resolvedProbe);

  const strictList = candidateModels.filter((m) => classifyModel(m.id, { reasoning: m.reasoning }) === "strict");
  const scoutList = candidateModels.filter((m) => classifyModel(m.id, { reasoning: m.reasoning }) === "scout");
  const builderList = candidateModels.filter((m) => classifyModel(m.id, { reasoning: m.reasoning }) === "builder");

  return {
    strict: {
      chain: buildCategoryChain(strictList, candidateModels),
      effort: "high",
    },
    builder: {
      chain: buildCategoryChain(builderList, candidateModels),
      effort: "medium",
    },
    scout: {
      chain: buildCategoryChain(scoutList, candidateModels),
      effort: "low",
    },
  };
}

export async function applyCategories(modelsPath, { yes = false, plan = null, probeResults = null, probeRunner = null } = {}) {
  if (!yes) {
    throw new Error("Refused: --apply requires --yes for explicit approval.");
  }
  if (!existsSync(modelsPath)) {
    throw new Error(`models file not found: ${modelsPath}`);
  }

  const rawContent = readFileSync(modelsPath, "utf8");
  const doc = yaml.parseDocument(rawContent, { keepSourceTokens: true });
  if (doc.errors && doc.errors.length > 0) {
    throw new Error(`YAML syntax error in ${modelsPath}: ${doc.errors[0].message}`);
  }

  const finalPlan = plan || await planCategories(rawContent, { probeResults, probeRunner });
  doc.set("categories", finalPlan);

  const updatedContent = doc.toString();
  writeFileSync(modelsPath, updatedContent, "utf8");
  return { ok: true, plan: finalPlan, path: modelsPath };
}

function loadCliProbeResults(args) {
  if (args["probe-file"]) {
    try {
      return JSON.parse(readFileSync(resolve(args["probe-file"]), "utf8"));
    } catch (err) {
      throw new Error(`Failed to parse probe-file: ${err.message}`);
    }
  }
  if (args["probe-json"]) {
    try {
      return JSON.parse(args["probe-json"]);
    } catch (err) {
      throw new Error(`Failed to parse probe-json: ${err.message}`);
    }
  }
  return null;
}

function createMockProbeRunner(probeResults) {
  return (prov) => {
    const val = probeResults[prov.name];
    if (typeof val === "string") return { models: [], error: val };
    if (Array.isArray(val)) return { models: val, error: null };
    return { models: [], error: "No probe data" };
  };
}

function ensureModelsFile(modelsPath) {
  if (!existsSync(modelsPath)) {
    console.error(`models file not found: ${modelsPath}`);
    return 2;
  }
  try {
    const content = readFileSync(modelsPath, "utf8");
    const doc = yaml.parse(content);
    if (doc === null || typeof doc !== "object") {
      console.error(`models file not readable or empty: ${modelsPath}`);
      return 2;
    }
    return 0;
  } catch (err) {
    console.error(`Failed to read models file ${modelsPath}: ${err.message}`);
    return 2;
  }
}

function computePlan(modelsPath, args, probeResults) {
  return planCategories(modelsPath, {
    probeResults,
    probe: args.probe,
    probeRunner: probeProvider,
  });
}

async function handleScanCommand(modelsPath, probeResults) {
  const probeRunner = probeResults ? createMockProbeRunner(probeResults) : probeProvider;
  const results = await scanProviders(modelsPath, { probeRunner });
  console.log(JSON.stringify(results, null, 2));
  return 0;
}

async function handlePlanCommand(modelsPath, args, probeResults) {
  const plan = await computePlan(modelsPath, args, probeResults);
  console.log(yaml.stringify({ categories: plan }));
  return 0;
}

async function handleApplyCommand(modelsPath, args, probeResults) {
  if (!args.yes) {
    console.error("Refused: --apply requires --yes for explicit approval.");
    return 1;
  }
  const plan = await computePlan(modelsPath, args, probeResults);
  const result = await applyCategories(modelsPath, {
    yes: true,
    plan,
  });
  console.log(`Successfully applied categories to ${result.path}:\n`);
  console.log(yaml.stringify({ categories: result.plan }));
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const modelsPath = resolveModelsPath(args.models);
  let probeResults = null;
  try {
    probeResults = loadCliProbeResults(args);
  } catch (err) {
    console.error(`Failed to parse probe input: ${err.message}`);
    return 1;
  }

  if (args.scan || args.plan || args.apply) {
    const errCode = ensureModelsFile(modelsPath);
    if (errCode !== 0) return errCode;
  }

  if (args.scan) return handleScanCommand(modelsPath, probeResults);
  if (args.plan) return handlePlanCommand(modelsPath, args, probeResults);
  if (args.apply) return handleApplyCommand(modelsPath, args, probeResults);

  printHelp();
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().then((code) => {
    process.exit(code || 0);
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
