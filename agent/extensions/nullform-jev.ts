/**
 * agent/extensions/nullform-jev.ts
 * Native OMP 18.4.4 extension for automatic JEV assistance:
 * - before_agent_start: appends skill recommendation via CustomMessagePayload (does NOT rewrite systemPrompt)
 * - tool_call: caches cheap routing decisions for uniquely named tasks and qualifying leaf archetypes
 * - before_subagent_spawn: routes approved child tasks matching exact spawnKey & role to validated candidate model
 * - Preserves explicit selectors (modelRole undefined), protected roles, and baseline behavior on any failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ToolCallEvent,
  BeforeSubagentSpawnEvent,
  BeforeSubagentSpawnEventResult,
  ProviderConfig,
  ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";

export type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ToolCallEvent,
  BeforeSubagentSpawnEvent,
  BeforeSubagentSpawnEventResult,
  ProviderConfig,
  ProviderModelConfig,
};

// ---------------------------------------------------------------------------
// Type Definitions (OMP 18.4.4 compatible)
// ---------------------------------------------------------------------------

export interface JevDecision {
  status: "ok" | "fallback";
  reason: string;
  skill: string | null;
  route: "cheap" | "baseline";
  archetype: "lookup" | "json-transform" | "formatting" | "text-normalization" | "none";
  confidence: number;
  eligibleScore?: number;
  skillConfidence?: number;
  routingConfidence?: number;
  model: string | null;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; costKnown?: boolean };
}

export interface JevCore {
  readCredential(): Promise<string | null>;
  loadSkillCatalog(options?: {
    cwd?: string;
    home?: string;
    roots?: string[];
    effectiveSkills?: Array<{ name: string; description: string; path?: string }>;
  }): Promise<{
    skills: Array<{ name: string; description: string; path?: string }>;
    fingerprint: string;
  }>;
  screenTask(text: string): { allowed: boolean; reason: string };
  decide(params: {
    task: string;
    skills: Array<{ name: string; description: string }>;
    apiKey: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    model?: string;
  }): Promise<JevDecision>;
  policyFingerprint(params: {
    catalogFingerprint: string;
    candidateModel: string;
    baselineModel: string;
    decisionModel: string;
  }): string;
  evaluateReport(report: unknown): {
    skillPassed: boolean;
    routingPassed: boolean;
    archetypes: string[];
  };
  readPolicy(options: { home?: string; cwd?: string; fingerprint?: string }): {
    version: number;
    enabled: boolean;
    expiresAt: string;
    catalogFingerprint: string;
    candidateModel: string;
    baselineModel: string;
    decisionModel: string;
    fingerprint: string;
    skillPassed: boolean;
    routingPassed: boolean;
    reportSha256: string;
    archetypes: string[];
    decisionSnapshots?: string[];
    modelPrices?: Record<string, { prompt?: number; completion?: number }> | null;
  } | null;
  appendEvent(cwd: string, event: Record<string, unknown>): void;
}

export interface JevCounters {
  skillRecommendations: number;
  actualRoutes: number;
  baselineRetained: number;
}

export interface JevExtensionOptions {
  core?: JevCore;
  candidateProvider?: boolean;
  home?: string;
  cwd?: string;
}


interface CachedDecision {
  decision: JevDecision;
  role: string;
  name: string;
  generation: number;
  timestamp: number;
}

interface TaskItemInput {
  name?: string;
  agent?: string;
  task?: string;
  prompt?: string;
  description?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants & Static Lookup Tables (ts-set-map compliance)
// ---------------------------------------------------------------------------

const PROTECTED_ROLES: Record<string, true> = {
  oracle: true,
  reviewer: true,
  "security-reviewer": true,
  orchestrator: true,
  designer: true,
  fixer: true,
  librarian: true,
};

const QUALIFYING_ROLES: Record<string, true> = {
  task: true,
  sonic: true,
  explorer: true,
  scout: true,
};

const LEAF_ARCHETYPES: Record<string, true> = {
  lookup: true,
  "json-transform": true,
  formatting: true,
  "text-normalization": true,
};

// ---------------------------------------------------------------------------
// Core Resolver
// ---------------------------------------------------------------------------

async function resolveCoreModule(
  cwd: string,
  userHome: string,
  override?: JevCore
): Promise<JevCore | null> {
  if (override) return override;

  const currentDir = typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

  // 1. Pointer check via .harness-root
  const pointerCandidates = [
    process.env.AGENT_DIR ? join(process.env.AGENT_DIR, ".harness-root") : null,
    join(userHome, ".omp", "agent", ".harness-root"),
    join(currentDir, "..", ".harness-root"),
    join(cwd, ".omp", "agent", ".harness-root"),
  ].filter((p): p is string => Boolean(p));

  for (const ptrPath of pointerCandidates) {
    if (existsSync(ptrPath)) {
      try {
        const harnessRoot = readFileSync(ptrPath, "utf8").trim();
        const corePath = join(harnessRoot, "tools", "jev-assist.mjs");
        if (existsSync(corePath)) {
          // Dynamic import required: core module path is determined at runtime via harness root pointer
          const mod: unknown = await import(pathToFileURL(corePath).href);
          return mod as JevCore;
        }
      } catch {}
    }
  }

  // 2. Source fallback relative to extension location and process.cwd()
  const fallbackCandidates = [
    resolve(currentDir, "../../tools/jev-assist.mjs"),
    join(cwd, "tools", "jev-assist.mjs"),
  ];

  for (const fbPath of fallbackCandidates) {
    if (existsSync(fbPath)) {
      try {
        // Dynamic import required: source fallback path resolved at runtime
        const mod: unknown = await import(pathToFileURL(fbPath).href);
        return mod as JevCore;
      } catch {}
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeErrorMessage(err: unknown): string {
  if (!err) return "unknown";
  if (err instanceof Error) {
    if (err.name === "AbortError") return "timeout";
    if (err.name === "TypeError") return "type_error";
    if (err.name === "RangeError") return "range_error";
    if (err.name === "SyntaxError") return "syntax_error";
    return err.name || "error";
  }
  return "internal_error";
}

/**
 * Extracts authoritative active skills directly from native session commands.
 * Strictly requires source === 'skill' (rejects prefix-spoofed prompt/extension commands),
 * strips 'skill:' command prefix and preserves namespaces and metadata.
 */
export function getEffectiveNativeSkills(
  pi: ExtensionAPI
): Array<{ name: string; description: string; path?: string }> | null {
  if (!pi || typeof pi.getCommands !== "function") return null;
  let commands: unknown;
  try {
    commands = pi.getCommands();
  } catch {
    return null;
  }
  if (!Array.isArray(commands)) return null;

  const result: Array<{ name: string; description: string; path?: string }> = [];
  for (const cmd of commands) {
    if (!cmd || typeof cmd !== "object") continue;
    const item = cmd as { name?: unknown; description?: unknown; source?: unknown; path?: unknown };
    if (item.source !== "skill") continue;

    const rawName = typeof item.name === "string" ? item.name : "";
    const name = rawName.startsWith("skill:") ? rawName.slice("skill:".length) : rawName;
    if (!name) continue;

    result.push({
      name,
      description: typeof item.description === "string" ? item.description : "",
      ...(typeof item.path === "string" ? { path: item.path } : {}),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Extension Factory
// ---------------------------------------------------------------------------

export function createJevExtension(options: JevExtensionOptions = {}) {
  const counters: JevCounters = {
    skillRecommendations: 0,
    actualRoutes: 0,
    baselineRetained: 0,
  };

  return async function jevExtension(pi: ExtensionAPI): Promise<void> {
    const userHome = options.home || process.env.USERPROFILE || process.env.HOME || homedir();
    const cwd = options.cwd || process.cwd();

    let resolvedCore: JevCore | null = options.core || null;
    const getCore = async (): Promise<JevCore | null> => {
      if (!resolvedCore) {
        resolvedCore = await resolveCoreModule(cwd, userHome, options.core);
      }
      return resolvedCore;
    };

    // State per turn: keyed by unique task name
    const pendingDecisions = new Map<string, CachedDecision>();
    let toolCallGeneration = 0;

    function clearTurnState(): void {
      pendingDecisions.clear();
      toolCallGeneration++;
    }

    const getPolicy = async () => {
      const core = await getCore();
      if (!core) return null;

      const effectiveSkills = getEffectiveNativeSkills(pi);
      if (!effectiveSkills || effectiveSkills.length === 0) return null;

      const catalog = await core.loadSkillCatalog({ cwd, home: userHome, effectiveSkills });
      if (!catalog.skills || catalog.skills.length === 0) return null;

      const policy = core.readPolicy({ home: userHome, cwd });
      if (!policy || !policy.enabled) return null;
      if (policy.catalogFingerprint && policy.catalogFingerprint !== catalog.fingerprint) return null;

      return { core, policy, catalog };
    };

    const getRoutingPolicy = async () => {
      const pair = await getPolicy();
      if (!pair || !pair.policy.routingPassed) return null;
      if (!Array.isArray(pair.policy.archetypes) || pair.policy.archetypes.length === 0) return null;
      return pair;
    };

    const getSkillPolicy = async () => {
      const pair = await getPolicy();
      if (!pair || !pair.policy.skillPassed) return null;
      return pair;
    };

    let providerRegistered = false;

    // Automatic in-memory candidate provider registration:
    // Only registered when candidateProvider !== false, credential + policy exist,
    // and candidate native model is unavailable.
    async function ensureCandidateProvider(ctx?: ExtensionContext): Promise<void> {
      if (providerRegistered) return;
      if (options.candidateProvider === false) return;
      if (typeof pi.registerProvider !== "function") return;

      const routing = await getRoutingPolicy();
      if (!routing || !routing.policy.candidateModel) return;
      const { core, policy } = routing;

      if (!policy.routingPassed || !Array.isArray(policy.archetypes) || policy.archetypes.length === 0) return;

      const apiKey = await core.readCredential();
      if (!apiKey) return;

      const candidateID = policy.candidateModel.startsWith("nullform-openrouter/")
        ? policy.candidateModel.slice("nullform-openrouter/".length)
        : policy.candidateModel;

      // Check if candidate native model is already available in session registry with valid positive cost
      if (ctx?.models?.resolve) {
        const existingNative = ctx.models.resolve(candidateID);
        if (
          existingNative &&
          existingNative.cost &&
          typeof existingNative.cost.input === "number" &&
          typeof existingNative.cost.output === "number" &&
          Number.isFinite(existingNative.cost.input) &&
          Number.isFinite(existingNative.cost.output) &&
          existingNative.cost.input > 0 &&
          existingNative.cost.output > 0
        ) {
          return;
        }
      }

      const baseID = policy.baselineModel?.startsWith("nullform-openrouter/")
        ? policy.baselineModel.slice("nullform-openrouter/".length)
        : (policy.baselineModel || "google/gemini-3.8-flash");

      // Extract observed prices from policy.modelPrices in memory (no repeated network fetches)
      const candPrices = policy.modelPrices?.[policy.candidateModel] || policy.modelPrices?.[candidateID];
      const basePrices = policy.modelPrices?.[policy.baselineModel] || policy.modelPrices?.[baseID];

      const toCostM = (val: unknown, fallback: number): number => {
        const n = typeof val === "number" && Number.isFinite(val) ? val : fallback;
        if (n > 0 && n < 0.01) {
          return Number((n * 1_000_000).toFixed(4));
        }
        return n;
      };

      const candInputCost = toCostM(candPrices?.prompt, 0.25);
      const candOutputCost = toCostM(candPrices?.completion, 1.5);
      const baseInputCost = toCostM(basePrices?.prompt, 0.75);
      const baseOutputCost = toCostM(basePrices?.completion, 3.75);

      const models: ProviderModelConfig[] = [
        {
          id: candidateID,
          name: candidateID === "google/gemini-3.1-flash-lite" ? "Google Gemini 3.1 Flash Lite" : candidateID,
          reasoning: false,
          input: ["text", "image"],
          cost: { input: candInputCost, output: candOutputCost, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1048576,
          maxTokens: 65536,
        },
      ];

      if (baseID && baseID !== candidateID) {
        models.push({
          id: baseID,
          name: baseID === "google/gemini-3.8-flash" ? "Google Gemini 3.8 Flash" : baseID,
          reasoning: false,
          input: ["text", "image"],
          cost: { input: baseInputCost, output: baseOutputCost, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1048576,
          maxTokens: 65536,
        });
      }

      pi.registerProvider("nullform-openrouter", {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey,
        api: "openai-completions",
        models,
      });

      providerRegistered = true;
    }

    // Default runtime automatic provider registration
    try {
      await ensureCandidateProvider();
    } catch (err) {
      pi.logger?.warn?.(`[nullform-jev] candidate provider registration error: ${safeErrorMessage(err)}`);
    }

    // Lifecycle turn cleanup
    pi.on("turn_start", () => clearTurnState());
    pi.on("turn_end", () => clearTurnState());
    pi.on("agent_end", () => clearTurnState());

    // 1. before_agent_start: Appends skill suggestion without rewriting systemPrompt
    pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
      try {
        if (ctx.agent?.kind === "sub") return;
        clearTurnState();

        const skillPair = await getSkillPolicy();
        if (!skillPair) return;
        const { core, policy, catalog } = skillPair;

        const promptText = typeof event.prompt === "string" ? event.prompt : "";
        if (!promptText.trim()) return;

        const screened = core.screenTask(promptText);
        if (!screened.allowed) return;

        const apiKey = await core.readCredential();
        if (!apiKey) return;

        const decision = await core.decide({
          task: promptText,
          skills: catalog.skills,
          apiKey,
        });

        if (decision && decision.status === "ok" && decision.skill) {
          // Re-evaluate decision snapshot against policy
          if (
            !decision.model ||
            (Array.isArray(policy.decisionSnapshots) &&
             policy.decisionSnapshots.length > 0 &&
             !policy.decisionSnapshots.includes(decision.model))
          ) {
            return;
          }

          // Calibrated skill confidence threshold check (independent of cheap-routing eligibleScore)
          const skillConf = decision.skillConfidence;

          if (
            typeof skillConf !== "number" ||
            !Number.isFinite(skillConf) ||
            skillConf < 0.80
          ) {
            return;
          }

          const matchedSkill = catalog.skills.find(s => s.name === decision.skill);
          if (!matchedSkill) return;

          counters.skillRecommendations++;
          core.appendEvent(cwd, {
            event: "skill_recommendation",
            skill: matchedSkill.name,
            archetype: decision.archetype,
            confidence: decision.confidence,
            route: decision.route,
            costUsd: decision.usage?.costUsd,
          });

          // Header skills emit short skill IDs only, with bounded archetype identifier hint
          const archetypeHint = decision.archetype && decision.archetype !== "none" ? ` (${decision.archetype})` : "";
          return {
            message: {
              customType: "jev-skill-suggestion",
              content: `[JEV Assistance] Recommended skill: ${matchedSkill.name}${archetypeHint}`,
              display: true,
            },
          };
        }
      } catch (err) {
        pi.logger?.warn?.(`[nullform-jev] before_agent_start error: ${safeErrorMessage(err)}`);
        return;
      }
    });

    // 2. tool_call: Caches decisions for explicit unique names and exact role
    pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
      try {
        if (ctx.agent?.kind === "sub") return;
        if (event.toolName !== "task" || !event.input) return;

        const currentGeneration = ++toolCallGeneration;

        const routing = await getRoutingPolicy();
        if (!routing) return;
        if (currentGeneration !== toolCallGeneration) return;
        const { core, policy, catalog } = routing;

        const input = event.input;
        if (!input || typeof input !== "object") return;

        // Screen shared batch context before any candidate registration or classifier decisions
        const rawContext = (input as { context?: unknown }).context;
        const sharedContextText = typeof rawContext === "string"
          ? rawContext
          : (rawContext ? JSON.stringify(rawContext) : "");

        if (sharedContextText.trim()) {
          const contextScreened = core.screenTask(sharedContextText);
          if (!contextScreened.allowed) {
            clearTurnState();
            return; // Sensitive shared context retains baseline for entire batch
          }
        }

        const rawTasks: TaskItemInput[] = [];
        if (Array.isArray((input as { tasks?: unknown }).tasks)) {
          for (const item of (input as { tasks: unknown[] }).tasks) {
            if (item && typeof item === "object") {
              rawTasks.push(item as TaskItemInput);
            }
          }
        } else {
          rawTasks.push(input as TaskItemInput);
        }

        // Check name uniqueness in batch
        const nameCounts = new Map<string, number>();
        for (const t of rawTasks) {
          const name = typeof t.name === "string" ? t.name.trim() : "";
          if (name) {
            nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
          }
        }

        // Invalidate prior pending map entries for names that are ambiguous in this batch
        for (const [name, count] of nameCounts.entries()) {
          if (count > 1) {
            pendingDecisions.delete(name);
          }
        }

        const apiKey = await core.readCredential();
        if (!apiKey || currentGeneration !== toolCallGeneration) return;

        await ensureCandidateProvider(ctx);
        if (currentGeneration !== toolCallGeneration) return;
        for (const t of rawTasks) {
          const name = typeof t.name === "string" ? t.name.trim() : "";
          if (!name) continue; // Unnamed task: never route
          if ((nameCounts.get(name) || 0) > 1) {
            pendingDecisions.delete(name);
            continue; // Ambiguous duplicate names: never route and cleared
          }

          const role = (typeof t.agent === "string" ? t.agent.trim() : "task").toLowerCase();
          if (PROTECTED_ROLES[role] || !QUALIFYING_ROLES[role]) {
            pendingDecisions.delete(name);
            continue; // Protected or non-qualifying role: never route and clear stale
          }

          const taskText = typeof t.task === "string"
            ? t.task
            : (typeof t.prompt === "string"
              ? t.prompt
              : (typeof t.description === "string" ? t.description : ""));

          if (!taskText || !taskText.trim()) continue;

          const screened = core.screenTask(taskText);
          if (!screened.allowed) {
            pendingDecisions.delete(name);
            continue;
          }

          const decision = await core.decide({
            task: taskText,
            skills: [],
            apiKey,
          });

          if (currentGeneration !== toolCallGeneration) {
            return;
          }

          // Check decision snapshot against policy.decisionSnapshots
          if (
            !decision?.model ||
            (Array.isArray(policy.decisionSnapshots) &&
             policy.decisionSnapshots.length > 0 &&
             !policy.decisionSnapshots.includes(decision.model))
          ) {
            pendingDecisions.delete(name);
            continue;
          }

          // Calibrated eligibleScore and archetype confidence independent of skill confidence
          const eligibleScore = decision?.eligibleScore;
          const routingConf = decision?.routingConfidence;

          if (
            decision &&
            decision.status === "ok" &&
            decision.route === "cheap" &&
            typeof eligibleScore === "number" &&
            Number.isFinite(eligibleScore) &&
            eligibleScore >= 0.95 &&
            typeof routingConf === "number" &&
            Number.isFinite(routingConf) &&
            routingConf >= 0.90 &&
            LEAF_ARCHETYPES[decision.archetype] &&
            Array.isArray(policy.archetypes) &&
            policy.archetypes.includes(decision.archetype)
          ) {
            if (currentGeneration === toolCallGeneration) {
              pendingDecisions.set(name, {
                decision,
                role,
                name,
                generation: currentGeneration,
                timestamp: Date.now(),
              });
            }
          } else {
            pendingDecisions.delete(name);
          }
        }
      } catch (err) {
        pi.logger?.warn?.(`[nullform-jev] tool_call error: ${safeErrorMessage(err)}`);
      }
    });

    // 3. before_subagent_spawn: Routes child tasks to candidate model if identity and role correlate
    pi.on("before_subagent_spawn", async (event: BeforeSubagentSpawnEvent, ctx: ExtensionContext) => {
      try {
        if (ctx.agent?.kind === "sub") return;
        if (event.invocationKind === "eval") return; // Never route eval spawns
        if (event.modelRole === undefined) return; // Preserve explicit caller selectors

        const spawnAgent = typeof event.agent === "string" ? event.agent.toLowerCase() : "";
        const spawnRole = typeof event.modelRole === "string" ? event.modelRole.toLowerCase() : "";

        if (PROTECTED_ROLES[spawnAgent] || PROTECTED_ROLES[spawnRole]) {
          counters.baselineRetained++;
          return; // Protected roles must retain baseline
        }

        const spawnKey = typeof event.spawnKey === "string" ? event.spawnKey.trim() : "";
        if (!spawnKey) {
          counters.baselineRetained++;
          return; // Unnamed spawn: retain baseline
        }

        const cached = pendingDecisions.get(spawnKey);
        if (!cached) {
          counters.baselineRetained++;
          return; // Unknown or consumed decision: retain baseline
        }

        if (cached.generation !== toolCallGeneration) {
          pendingDecisions.delete(spawnKey);
          counters.baselineRetained++;
          return; // Stale generation decision: retain baseline
        }

        // Verify exact role match BEFORE consuming
        if (spawnAgent !== cached.role && spawnRole !== cached.role) {
          counters.baselineRetained++;
          return; // Role mismatch retains baseline without consuming
        }

        // Verify freshness (< 2 minutes old)
        if (Date.now() - cached.timestamp > 120000) {
          pendingDecisions.delete(spawnKey);
          counters.baselineRetained++;
          return;
        }

        const routing = await getRoutingPolicy();
        if (!routing) {
          counters.baselineRetained++;
          return;
        }
        const { core, policy, catalog } = routing;

        if (
          !policy.candidateModel ||
          !Array.isArray(policy.archetypes) ||
          !policy.archetypes.includes(cached.decision.archetype) ||
          !LEAF_ARCHETYPES[cached.decision.archetype]
        ) {
          counters.baselineRetained++;
          return;
        }

        // Re-evaluate decision snapshot against policy.decisionSnapshots
        if (
          !cached.decision.model ||
          (Array.isArray(policy.decisionSnapshots) &&
           policy.decisionSnapshots.length > 0 &&
           !policy.decisionSnapshots.includes(cached.decision.model))
        ) {
          counters.baselineRetained++;
          return;
        }

        await ensureCandidateProvider(ctx);

        const candidateID = policy.candidateModel.startsWith("nullform-openrouter/")
          ? policy.candidateModel.slice("nullform-openrouter/".length)
          : policy.candidateModel;
        const fullCandidateSelector = "nullform-openrouter/" + candidateID;

        // Verify candidate model availability and observed prices via ctx.models
        const targetModel =
          (ctx.models?.resolve ? ctx.models.resolve(fullCandidateSelector) : undefined) ||
          (ctx.models?.resolve ? ctx.models.resolve(policy.candidateModel) : undefined) ||
          (ctx.models?.resolve ? ctx.models.resolve(candidateID) : undefined) ||
          (ctx.models?.list ? ctx.models.list().find(m => m.id === fullCandidateSelector || m.id === policy.candidateModel || m.id === candidateID) : undefined);

        if (!targetModel) {
          counters.baselineRetained++;
          return; // Candidate model not available in session registry: retain baseline
        }

        if (
          !targetModel.cost ||
          typeof targetModel.cost.input !== "number" ||
          typeof targetModel.cost.output !== "number" ||
          !Number.isFinite(targetModel.cost.input) ||
          !Number.isFinite(targetModel.cost.output) ||
          targetModel.cost.input <= 0 ||
          targetModel.cost.output <= 0
        ) {
          counters.baselineRetained++;
          return; // Unobserved or zero price: retain baseline
        }

        // Measured baseline comparison
        const baselineModel = policy.baselineModel
          ? ((ctx.models?.resolve ? ctx.models.resolve(policy.baselineModel) : undefined) ||
             (ctx.models?.list ? ctx.models.list().find(m => m.id === policy.baselineModel) : undefined))
          : undefined;

        if (
          baselineModel?.cost?.input &&
          typeof baselineModel.cost.input === "number" &&
          Number.isFinite(baselineModel.cost.input) &&
          baselineModel.cost.input > 0 &&
          targetModel.cost.input >= baselineModel.cost.input
        ) {
          counters.baselineRetained++;
          return; // Candidate model not cheaper than measured baseline: retain baseline
        }

        // All verifications confirmed: consume decision once
        pendingDecisions.delete(spawnKey);

        counters.actualRoutes++;
        core.appendEvent(cwd, {
          event: "subagent_routed",
          agent: event.agent,
          spawnKey,
          candidateModel: fullCandidateSelector,
          archetype: cached.decision.archetype,
          costUsd: cached.decision.usage?.costUsd,
        });

        // Return full selector nullform-openrouter/${candidateID} with original patterns fallback
        const originalPatterns = Array.isArray(event.patterns) ? event.patterns : [];
        const replacementModels = [
          fullCandidateSelector,
          ...originalPatterns.filter(p => p !== fullCandidateSelector),
        ];

        return {
          model: replacementModels,
          note: `jev: routed archetype=${cached.decision.archetype} to ${fullCandidateSelector}`,
        };
      } catch (err) {
        counters.baselineRetained++;
        pi.logger?.warn?.(`[nullform-jev] before_subagent_spawn error: ${safeErrorMessage(err)}`);
        return;
      }
    });
  };
}

export default createJevExtension();
