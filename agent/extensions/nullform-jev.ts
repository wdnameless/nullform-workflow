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
  ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";


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
  }): Promise<{ skills: Array<{ name: string; description: string; path?: string }>; fingerprint: string }>;
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


async function resolveCoreModule(
  cwd: string,
  userHome: string,
  override?: JevCore
): Promise<JevCore | null> {
  if (override) return override;
  const currentDir = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));

  const pointerCandidates = [
    process.env.AGENT_DIR ? join(process.env.AGENT_DIR, ".harness-root") : null,
    join(userHome, ".omp", "agent", ".harness-root"),
    join(currentDir, "..", ".harness-root"),
    join(cwd, ".omp", "agent", ".harness-root"),
  ].filter((p): p is string => Boolean(p));

  for (const ptrPath of pointerCandidates) {
    if (existsSync(ptrPath)) {
      try {
        const corePath = join(readFileSync(ptrPath, "utf8").trim(), "tools", "jev-assist.mjs");
        if (existsSync(corePath)) {
          return (await import(pathToFileURL(corePath).href)) as JevCore;
        }
      } catch {}
    }
  }

  const fallbacks = [resolve(currentDir, "../../tools/jev-assist.mjs"), join(cwd, "tools", "jev-assist.mjs")];
  for (const fbPath of fallbacks) {
    if (existsSync(fbPath)) {
      try {
        return (await import(pathToFileURL(fbPath).href)) as JevCore;
      } catch {}
    }
  }
  return null;
}

function safeErrorMessage(err: unknown): string {
  if (!err) return "unknown";
  if (err instanceof Error) {
    const n = err.name;
    if (n === "AbortError") return "timeout";
    if (n === "TypeError") return "type_error";
    if (n === "RangeError") return "range_error";
    if (n === "SyntaxError") return "syntax_error";
    return n || "error";
  }
  return "internal_error";
}

const isAllowedSnapshot = (model: string | null | undefined, snapshots?: string[]): boolean =>
  Boolean(model && (!Array.isArray(snapshots) || snapshots.length === 0 || snapshots.includes(model)));

const hasValidCost = (m?: { cost?: { input?: unknown; output?: unknown } }): boolean =>
  Boolean(
    m?.cost &&
    typeof m.cost.input === "number" &&
    typeof m.cost.output === "number" &&
    Number.isFinite(m.cost.input) &&
    Number.isFinite(m.cost.output) &&
    m.cost.input > 0 &&
    m.cost.output > 0
  );

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


class JevRuntime {
  private resolvedCore: JevCore | null = null;
  private readonly pendingDecisions = new Map<string, CachedDecision>();
  private toolCallGeneration = 0;
  private providerRegistered = false;
  private readonly userHome: string;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: JevExtensionOptions,
    private readonly counters: JevCounters
  ) {
    this.userHome = options.home || process.env.USERPROFILE || process.env.HOME || homedir();
    this.resolvedCore = options.core || null;
  }

  resolveCwd(ctx?: ExtensionContext): string {
    return this.options.cwd || ctx?.cwd || process.cwd();
  }

  clearTurnState(): void {
    this.pendingDecisions.clear();
    this.toolCallGeneration++;
  }

  async getCore(ctx?: ExtensionContext): Promise<JevCore | null> {
    if (!this.resolvedCore) {
      this.resolvedCore = await resolveCoreModule(this.resolveCwd(ctx), this.userHome, this.options.core);
    }
    return this.resolvedCore;
  }

  async getPolicy(ctx?: ExtensionContext) {
    const core = await this.getCore(ctx);
    if (!core) return null;

    const effectiveSkills = getEffectiveNativeSkills(this.pi);
    if (!effectiveSkills || effectiveSkills.length === 0) return null;

    const currentCwd = this.resolveCwd(ctx);
    const catalog = await core.loadSkillCatalog({ cwd: currentCwd, home: this.userHome, effectiveSkills });
    if (!catalog.skills || catalog.skills.length === 0) return null;

    const policy = core.readPolicy({ home: this.userHome, cwd: currentCwd });
    if (!policy || !policy.enabled) return null;
    if (policy.catalogFingerprint && policy.catalogFingerprint !== catalog.fingerprint) return null;

    return { core, policy, catalog, cwd: currentCwd };
  }

  async getRoutingPolicy(ctx?: ExtensionContext) {
    const pair = await this.getPolicy(ctx);
    if (!pair || !pair.policy.routingPassed) return null;
    if (!Array.isArray(pair.policy.archetypes) || pair.policy.archetypes.length === 0) return null;
    return pair;
  }

  async getSkillPolicy(ctx?: ExtensionContext) {
    const pair = await this.getPolicy(ctx);
    if (!pair || !pair.policy.skillPassed) return null;
    return pair;
  }

  async ensureCandidateProvider(ctx?: ExtensionContext): Promise<void> {
    if (this.providerRegistered || this.options.candidateProvider === false) return;
    if (typeof this.pi.registerProvider !== "function") return;

    const routing = await this.getRoutingPolicy(ctx);
    if (!routing || !routing.policy.candidateModel) return;
    const { core, policy } = routing;

    if (!policy.routingPassed || !Array.isArray(policy.archetypes) || policy.archetypes.length === 0) return;

    const apiKey = await core.readCredential();
    if (!apiKey) return;

    const candidateID = policy.candidateModel.startsWith("nullform-openrouter/")
      ? policy.candidateModel.slice("nullform-openrouter/".length)
      : policy.candidateModel;

    if (ctx?.models?.resolve && hasValidCost(ctx.models.resolve(candidateID))) {
      return;
    }

    const baseID = policy.baselineModel?.startsWith("nullform-openrouter/")
      ? policy.baselineModel.slice("nullform-openrouter/".length)
      : (policy.baselineModel || "google/gemini-3.8-flash");

    const candPrices = policy.modelPrices?.[policy.candidateModel] || policy.modelPrices?.[candidateID];
    const basePrices = policy.modelPrices?.[policy.baselineModel] || policy.modelPrices?.[baseID];

    const toCostM = (val: unknown, fallback: number): number => {
      const n = typeof val === "number" && Number.isFinite(val) ? val : fallback;
      return (n > 0 && n < 0.01) ? Number((n * 1_000_000).toFixed(4)) : n;
    };

    const makeModelConfig = (id: string, name: string, inCost: number, outCost: number): ProviderModelConfig => ({
      id,
      name,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: inCost, output: outCost, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 65536,
    });

    const models: ProviderModelConfig[] = [
      makeModelConfig(
        candidateID,
        candidateID === "google/gemini-3.1-flash-lite" ? "Google Gemini 3.1 Flash Lite" : candidateID,
        toCostM(candPrices?.prompt, 0.25),
        toCostM(candPrices?.completion, 1.5)
      ),
    ];

    if (baseID && baseID !== candidateID) {
      models.push(
        makeModelConfig(
          baseID,
          baseID === "google/gemini-3.8-flash" ? "Google Gemini 3.8 Flash" : baseID,
          toCostM(basePrices?.prompt, 0.75),
          toCostM(basePrices?.completion, 3.75)
        )
      );
    }

    this.pi.registerProvider("nullform-openrouter", {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey,
      api: "openai-completions",
      models,
    });

    this.providerRegistered = true;
  }

  async handleBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext
  ): Promise<BeforeAgentStartEventResult | void> {
    try {
      if (ctx.agent?.kind === "sub") return;
      this.clearTurnState();

      const skillPair = await this.getSkillPolicy(ctx);
      if (!skillPair) return;
      const { core, policy, catalog, cwd } = skillPair;

      const promptText = typeof event.prompt === "string" ? event.prompt : "";
      if (!promptText.trim() || !core.screenTask(promptText).allowed) return;

      const apiKey = await core.readCredential();
      if (!apiKey) return;

      const decision = await core.decide({ task: promptText, skills: catalog.skills, apiKey });
      if (decision && decision.status === "ok" && decision.skill) {
        if (!isAllowedSnapshot(decision.model, policy.decisionSnapshots)) return;

        const skillConf = decision.skillConfidence;
        if (typeof skillConf !== "number" || !Number.isFinite(skillConf) || skillConf < 0.80) {
          return;
        }

        const matchedSkill = catalog.skills.find(s => s.name === decision.skill);
        if (!matchedSkill) return;

        this.counters.skillRecommendations++;
        core.appendEvent(cwd, {
          event: "skill_recommendation",
          skill: matchedSkill.name,
          archetype: decision.archetype,
          confidence: decision.confidence,
          route: decision.route,
          costUsd: decision.usage?.costUsd,
        });

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
      this.pi.logger?.warn?.(`[nullform-jev] before_agent_start error: ${safeErrorMessage(err)}`);
      return;
    }
  }

  async handleToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<void> {
    try {
      if (ctx.agent?.kind === "sub") return;
      if (event.toolName !== "task" || !event.input) return;

      const currentGeneration = ++this.toolCallGeneration;

      const routing = await this.getRoutingPolicy(ctx);
      if (!routing || currentGeneration !== this.toolCallGeneration) return;
      const { core, policy } = routing;

      const input = event.input;
      if (!input || typeof input !== "object") return;

      const rawContext = (input as { context?: unknown }).context;
      const sharedContextText = typeof rawContext === "string" ? rawContext : (rawContext ? JSON.stringify(rawContext) : "");
      if (sharedContextText.trim() && !core.screenTask(sharedContextText).allowed) {
        this.clearTurnState();
        return;
      }

      const rawTasks: TaskItemInput[] = Array.isArray((input as { tasks?: unknown }).tasks)
        ? ((input as { tasks: unknown[] }).tasks.filter(t => t && typeof t === "object") as TaskItemInput[])
        : [input as TaskItemInput];

      const nameCounts = new Map<string, number>();
      for (const t of rawTasks) {
        const name = typeof t.name === "string" ? t.name.trim() : "";
        if (name) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      }
      for (const [name, count] of nameCounts.entries()) {
        if (count > 1) this.pendingDecisions.delete(name);
      }

      const apiKey = await core.readCredential();
      if (!apiKey || currentGeneration !== this.toolCallGeneration) return;

      await this.ensureCandidateProvider(ctx);
      if (currentGeneration !== this.toolCallGeneration) return;

      for (const t of rawTasks) {
        const name = typeof t.name === "string" ? t.name.trim() : "";
        if (!name || (nameCounts.get(name) || 0) > 1) {
          if (name) this.pendingDecisions.delete(name);
          continue;
        }

        const role = (typeof t.agent === "string" ? t.agent.trim() : "task").toLowerCase();
        if (PROTECTED_ROLES[role] || !QUALIFYING_ROLES[role]) {
          this.pendingDecisions.delete(name);
          continue;
        }

        const taskText = typeof t.task === "string"
          ? t.task
          : (typeof t.prompt === "string" ? t.prompt : (typeof t.description === "string" ? t.description : ""));

        if (!taskText.trim() || !core.screenTask(taskText).allowed) {
          this.pendingDecisions.delete(name);
          continue;
        }

        const decision = await core.decide({ task: taskText, skills: [], apiKey });
        if (currentGeneration !== this.toolCallGeneration) return;

        if (!isAllowedSnapshot(decision?.model, policy.decisionSnapshots)) {
          this.pendingDecisions.delete(name);
          continue;
        }

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
          if (currentGeneration === this.toolCallGeneration) {
            this.pendingDecisions.set(name, {
              decision,
              role,
              name,
              generation: currentGeneration,
              timestamp: Date.now(),
            });
          }
        } else {
          this.pendingDecisions.delete(name);
        }
      }
    } catch (err) {
      this.pi.logger?.warn?.(`[nullform-jev] tool_call error: ${safeErrorMessage(err)}`);
    }
  }

  async handleBeforeSubagentSpawn(
    event: BeforeSubagentSpawnEvent,
    ctx: ExtensionContext
  ): Promise<BeforeSubagentSpawnEventResult | void> {
    try {
      if (ctx.agent?.kind === "sub" || event.invocationKind === "eval" || event.modelRole === undefined) return;

      const spawnAgent = typeof event.agent === "string" ? event.agent.toLowerCase() : "";
      const spawnRole = typeof event.modelRole === "string" ? event.modelRole.toLowerCase() : "";

      if (PROTECTED_ROLES[spawnAgent] || PROTECTED_ROLES[spawnRole]) {
        this.counters.baselineRetained++;
        return;
      }

      const spawnKey = typeof event.spawnKey === "string" ? event.spawnKey.trim() : "";
      if (!spawnKey) {
        this.counters.baselineRetained++;
        return;
      }

      const cached = this.pendingDecisions.get(spawnKey);
      if (!cached) {
        this.counters.baselineRetained++;
        return;
      }

      if (cached.generation !== this.toolCallGeneration) {
        this.pendingDecisions.delete(spawnKey);
        this.counters.baselineRetained++;
        return;
      }

      if (spawnAgent !== cached.role && spawnRole !== cached.role) {
        this.counters.baselineRetained++;
        return;
      }

      if (Date.now() - cached.timestamp > 120000) {
        this.pendingDecisions.delete(spawnKey);
        this.counters.baselineRetained++;
        return;
      }

      const routing = await this.getRoutingPolicy(ctx);
      if (!routing) {
        this.counters.baselineRetained++;
        return;
      }
      const { core, policy, cwd } = routing;

      if (
        !policy.candidateModel ||
        !Array.isArray(policy.archetypes) ||
        !policy.archetypes.includes(cached.decision.archetype) ||
        !LEAF_ARCHETYPES[cached.decision.archetype] ||
        !isAllowedSnapshot(cached.decision.model, policy.decisionSnapshots)
      ) {
        this.counters.baselineRetained++;
        return;
      }

      await this.ensureCandidateProvider(ctx);

      const candidateID = policy.candidateModel.startsWith("nullform-openrouter/")
        ? policy.candidateModel.slice("nullform-openrouter/".length)
        : policy.candidateModel;
      const fullCandidateSelector = "nullform-openrouter/" + candidateID;

      const resolveModel = (id: string) =>
        ctx.models?.resolve?.(id) || ctx.models?.list?.().find(m => m.id === id);

      const targetModel =
        resolveModel(fullCandidateSelector) ||
        resolveModel(policy.candidateModel) ||
        resolveModel(candidateID);

      if (!hasValidCost(targetModel)) {
        this.counters.baselineRetained++;
        return;
      }

      const baselineModel = policy.baselineModel ? resolveModel(policy.baselineModel) : undefined;

      if (
        baselineModel?.cost?.input &&
        typeof baselineModel.cost.input === "number" &&
        Number.isFinite(baselineModel.cost.input) &&
        baselineModel.cost.input > 0 &&
        (targetModel!.cost!.input as number) >= baselineModel.cost.input
      ) {
        this.counters.baselineRetained++;
        return;
      }

      this.pendingDecisions.delete(spawnKey);
      this.counters.actualRoutes++;

      core.appendEvent(cwd, {
        event: "subagent_routed",
        agent: event.agent,
        spawnKey,
        candidateModel: fullCandidateSelector,
        archetype: cached.decision.archetype,
        costUsd: cached.decision.usage?.costUsd,
      });

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
      this.counters.baselineRetained++;
      this.pi.logger?.warn?.(`[nullform-jev] before_subagent_spawn error: ${safeErrorMessage(err)}`);
      return;
    }
  }

  async init(): Promise<void> {
    try {
      await this.ensureCandidateProvider();
    } catch (err) {
      this.pi.logger?.warn?.(`[nullform-jev] candidate provider registration error: ${safeErrorMessage(err)}`);
    }

    this.pi.on("turn_start", () => this.clearTurnState());
    this.pi.on("turn_end", () => this.clearTurnState());
    this.pi.on("agent_end", () => this.clearTurnState());

    this.pi.on("before_agent_start", (event, ctx) => this.handleBeforeAgentStart(event, ctx));
    this.pi.on("tool_call", (event, ctx) => this.handleToolCall(event, ctx));
    this.pi.on("before_subagent_spawn", (event, ctx) => this.handleBeforeSubagentSpawn(event, ctx));
  }
}


export function createJevExtension(options: JevExtensionOptions = {}) {
  const counters: JevCounters = {
    skillRecommendations: 0,
    actualRoutes: 0,
    baselineRetained: 0,
  };

  return async function jevExtension(pi: ExtensionAPI): Promise<void> {
    const runtime = new JevRuntime(pi, options, counters);
    await runtime.init();
  };
}

export default createJevExtension();
