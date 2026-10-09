/**
 * agent/extensions/nullform-jev.ts
 *
 * Native OMP extension for automatic JEV assistance.
 * Operates strictly on main-session `before_agent_start`: provides a bounded
 * skill recommendation hint when confidence >= 0.80 under a valid v2 policy.
 * All model routing, provider registration, subagent mutations, and tool_call caches
 * are removed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
} from "@oh-my-pi/pi-coding-agent";

export interface JevDecision {
  status: "ok" | "fallback";
  reason: string;
  skill: string | null;
  confidence: number;
  model: string | null;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; costKnown?: boolean };
}

export interface JevPolicy {
  version: number;
  enabled: boolean;
  expiresAt: string;
  catalogFingerprint: string;
  baselineModel: string;
  decisionModel: string;
  fingerprint: string;
  reportSha256: string;
  decisionSnapshots?: string[];
  skillPassed?: boolean;
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
  readPolicy(options: { home?: string; cwd?: string; fingerprint?: string }): JevPolicy | null;
  appendEvent(cwd: string, event: Record<string, unknown>): void;
}

export interface JevExtensionOptions {
  core?: JevCore;
  home?: string;
  cwd?: string;
}

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
    return "error";
  }
  return "internal_error";
}

const isAllowedSnapshot = (
  model: string | null | undefined,
  policyDecisionModel?: string,
  snapshots?: string[]
): boolean => {
  if (!model) return false;
  if (Array.isArray(snapshots) && snapshots.length > 0) {
    return snapshots.includes(model);
  }
  return policyDecisionModel ? model === policyDecisionModel : true;
};

function isOptedOut(cwd: string, home: string): boolean {
  if (process.env.JEV_OPTOUT === "1" || process.env.JEV_DISABLED === "1") return true;
  const candidates = [
    join(cwd, ".jev-optout"),
    join(cwd, ".workflow", "jev-optout"),
    join(cwd, ".omp", "agent", "jev-optout"),
    join(home, ".omp", "agent", "jev-optout"),
    join(home, ".omp", "agent", ".jev-optout"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return true;
    } catch {}
  }
  return false;
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

class JevRuntime {
  private resolvedCore: JevCore | null = null;
  private readonly userHome: string;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: JevExtensionOptions
  ) {
    this.userHome = options.home || process.env.USERPROFILE || process.env.HOME || homedir();
    this.resolvedCore = options.core || null;
  }

  resolveCwd(ctx?: ExtensionContext): string {
    return this.options.cwd || ctx?.cwd || process.cwd();
  }

  async getCore(ctx?: ExtensionContext): Promise<JevCore | null> {
    if (!this.resolvedCore) {
      this.resolvedCore = await resolveCoreModule(this.resolveCwd(ctx), this.userHome, this.options.core);
    }
    return this.resolvedCore;
  }

  async getPolicy(ctx?: ExtensionContext) {
    const currentCwd = this.resolveCwd(ctx);
    if (isOptedOut(currentCwd, this.userHome)) return null;

    const core = await this.getCore(ctx);
    if (!core) return null;

    const effectiveSkills = getEffectiveNativeSkills(this.pi);
    if (!effectiveSkills || effectiveSkills.length === 0) return null;

    const catalog = await core.loadSkillCatalog({ cwd: currentCwd, home: this.userHome, effectiveSkills });
    if (!catalog.skills || catalog.skills.length === 0) return null;

    const policy = core.readPolicy({ home: this.userHome, cwd: currentCwd });
    if (!policy || !policy.enabled) return null;
    if (policy.catalogFingerprint && policy.catalogFingerprint !== catalog.fingerprint) return null;

    return { core, policy, catalog, cwd: currentCwd };
  }

  async handleBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext
  ): Promise<BeforeAgentStartEventResult | void> {
    try {
      if (ctx.agent?.kind === "sub") return;

      const policyContext = await this.getPolicy(ctx);
      if (!policyContext) return;
      const { core, policy, catalog, cwd } = policyContext;

      const promptText = typeof event.prompt === "string" ? event.prompt : "";
      if (!promptText.trim() || !core.screenTask(promptText).allowed) return;

      const apiKey = await core.readCredential();
      if (!apiKey) return;

      const decision = await core.decide({ task: promptText, skills: catalog.skills, apiKey });
      if (decision && decision.status === "ok" && decision.skill && decision.skill !== "none") {
        if (!isAllowedSnapshot(decision.model, policy.decisionModel, policy.decisionSnapshots)) return;

        const confidence = decision.confidence;
        if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0.80 || confidence > 1.0) {
          return;
        }

        const matchedSkill = catalog.skills.find((s) => s.name === decision.skill);
        if (!matchedSkill) return;

        core.appendEvent(cwd, {
          event: "skill_recommendation",
          skill: matchedSkill.name,
          confidence: decision.confidence,
          costUsd: decision.usage?.costUsd,
        });

        return {
          message: {
            customType: "jev-skill-suggestion",
            content: `[JEV Assistance] Recommended skill: ${matchedSkill.name}`,
            display: true,
          },
        };
      }
    } catch (err) {
      this.pi.logger?.warn?.(`[nullform-jev] before_agent_start error: ${safeErrorMessage(err)}`);
      return;
    }
  }

  async init(): Promise<void> {
    this.pi.on("before_agent_start", (event, ctx) => this.handleBeforeAgentStart(event, ctx));
  }
}

export function createJevExtension(options: JevExtensionOptions = {}) {
  return async function jevExtension(pi: ExtensionAPI): Promise<void> {
    const runtime = new JevRuntime(pi, options);
    await runtime.init();
  };
}

export default createJevExtension();
