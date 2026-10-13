/**
 * agent/extensions/nullform-delete-guard.ts
 *
 * Native OMP extension for delete guard.
 * Intercepts destructive shell commands (bash, eval) and requires explicit
 * user confirmation via ctx.ui.confirm() before execution.
 * Identified Git restoration is refused headlessly; other headless behavior is unchanged.
 * Command matching is a best-effort guard, not an arbitrary-shell sandbox.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  SessionStartEvent,
} from "@oh-my-pi/pi-coding-agent";

export interface DestructiveRule {
  re: RegExp;
  what: string;
  blockHeadless?: boolean;
}

export interface DeleteGuardResult {
  block: boolean;
  reason: string;
  deny: string;
}

// Git global options may precede the subcommand; shell wrappers may precede git.
const GIT_WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|]+)`;
const GIT_RESTORATION: DestructiveRule = {
  re: new RegExp(String.raw`\bgit(?:\.exe)?["']?\s+(?:(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)\s+${GIT_WORD}|(?:-C|-c)${GIT_WORD}|--(?:git-dir|work-tree|namespace|config-env)=${GIT_WORD}|-[pP]|--(?:no-pager|paginate|bare|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs|no-replace-objects|no-optional-locks))\s+)*(?:(?:checkout|restore)\b|stash(?:\s+(?:apply|pop|push|save|branch)\b|\s+-|(?=\s*(?:$|[;&|"']))))`),
  what: "заменить рабочие файлы или индекс (git checkout/restore/stash)",
  blockHeadless: true,
};

// 6 RULES ported 1:1 from nickvels delete-guard:
// Existing destructive operations retain their interactive-only permission behavior.
// rm is caught with recursion flag anywhere in command: rm -rf, rm -f -r, rm -v -R, rm --recursive.
export const RULES: DestructiveRule[] = [
  { re: /\brm\s+(?:[^;&|]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/, what: "удалить папку целиком" },
  { re: /\bgit\s+push\b.*(\s-f\b|--force)/, what: "перезаписать историю на сервере (force push)" },
  { re: /\bgit\s+reset\s+--hard\b/, what: "стереть несохранённые правки (git reset --hard)" },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, what: "удалить неотслеживаемые файлы (git clean)" },
  { re: /\bfind\b.*\s-delete\b/, what: "удалить найденные файлы (find -delete)" },
  { re: /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, what: "удалить данные из базы" },
];

let isInteractive = true;

export function setInteractive(value: boolean): void {
  isInteractive = value;
}

export function getInteractive(): boolean {
  return isInteractive;
}

export function matchDestructiveCommand(cmd: string): { what: string; rule?: DestructiveRule } | null {
  if (typeof cmd !== "string") return null;
  // Restoration must win even when another matched command precedes it.
  if (GIT_RESTORATION.re.test(cmd)) return { what: GIT_RESTORATION.what, rule: GIT_RESTORATION };
  for (const rule of RULES) {
    if (rule.re.test(cmd)) {
      return { what: rule.what, rule };
    }
  }
  return null;
}

// Paths after rm and its flags to count what will be deleted; ~ expands to home directory
export function rmTargets(
  cmd: string,
  home: string | undefined = process.env.HOME || process.env.USERPROFILE
): string[] {
  const m = cmd.match(/\brm\s+([^;&|]+)/);
  if (!m) return [];
  return m[1]
    .trim()
    .split(/\s+/)
    .filter((p) => p && !p.startsWith("-"))
    .map((p) => p.replace(/^["']|["']$/g, ""))
    .map((p) => (home && (p === "~" || p.startsWith("~/")) ? home + p.slice(1) : p))
    .slice(0, 10);
}

async function runExecHelper(
  execFn: Function,
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr?: string } | null> {
  const parseResult = (res: unknown): { stdout: string; stderr?: string } | null => {
    if (res && typeof res === "object" && "stdout" in res && typeof res.stdout === "string") {
      const stderr = "stderr" in res && typeof res.stderr === "string" ? res.stderr : undefined;
      return { stdout: res.stdout, stderr };
    }
    return null;
  };

  try {
    return parseResult(await execFn(cmd, args, { timeout: timeoutMs, timeoutMs }));
  } catch {
    try {
      return parseResult(await execFn([cmd, ...args], { timeout: timeoutMs, timeoutMs }));
    } catch {
      return null;
    }
  }
}

export async function computeRmScope(
  cmd: string,
  ctx?: unknown,
  home?: string
): Promise<string> {
  const targets = rmTargets(cmd, home);
  if (targets.length === 0) return "";
  try {
    if (!ctx || typeof ctx !== "object" || !("exec" in ctx) || typeof ctx.exec !== "function") return "";
    const execFn = ctx.exec;

    const files = await runExecHelper(execFn, "find", [...targets, "-type", "f"], 5000);
    const size = await runExecHelper(execFn, "du", ["-sch", ...targets], 5000);

    const n = (files?.stdout || "").split("\n").filter(Boolean).length;
    const total = (size?.stdout || "").trim().split("\n").pop()?.split(/\s+/)[0] ?? "";
    if (n > 0 || total) {
      return ` — ${n} файлов, ${total}`;
    }
  } catch {
    // on Windows without find/du or on error — proceed without scope count
  }
  return "";
}

export function buildDenyMessage(what: string): string {
  return `Страж удаления: пользователь отменил «${what}». Не повторяй эту команду; предложи безопасный вариант (копия, корзина) и спроси.`;
}

export function extractCommand(event: unknown): string | null {
  if (!event) return null;
  if (typeof event === "string") return event;
  if (typeof event !== "object") return null;

  const toolName = "toolName" in event && typeof event.toolName === "string"
    ? event.toolName.toLowerCase()
    : "tool" in event && typeof event.tool === "string"
      ? event.tool.toLowerCase()
      : "";

  const rawInput = "input" in event && event.input && typeof event.input === "object"
    ? event.input
    : "args" in event && event.args && typeof event.args === "object"
      ? event.args
      : event;

  if (toolName === "bash" || toolName === "") {
    if ("command" in rawInput && typeof rawInput.command === "string") return rawInput.command;
    if ("cmd" in rawInput && typeof rawInput.cmd === "string") return rawInput.cmd;
  }
  if (toolName === "eval") {
    if ("command" in rawInput && typeof rawInput.command === "string") return rawInput.command;
    if ("code" in rawInput && typeof rawInput.code === "string") return rawInput.code;
  }
  if ("command" in event && typeof event.command === "string") return event.command;
  return null;
}

export function handleSessionStart(event?: unknown, ctx?: unknown): void {
  if (event && typeof event === "object" && "isInteractive" in event && typeof event.isInteractive === "boolean") {
    isInteractive = event.isInteractive;
  } else if (ctx && typeof ctx === "object") {
    if ("isInteractive" in ctx && typeof ctx.isInteractive === "boolean") {
      isInteractive = ctx.isInteractive;
    } else if ("hasUI" in ctx && typeof ctx.hasUI === "boolean") {
      const mode = "mode" in ctx && typeof ctx.mode === "string" ? ctx.mode : "";
      isInteractive = ctx.hasUI && mode !== "print" && mode !== "rpc" && mode !== "json";
    }
  }
}

export async function handleToolCall(
  event: unknown,
  ctx?: unknown
): Promise<DeleteGuardResult | undefined> {
  const toolName = event && typeof event === "object" && "toolName" in event && typeof event.toolName === "string"
    ? event.toolName.toLowerCase()
    : event && typeof event === "object" && "tool" in event && typeof event.tool === "string"
      ? event.tool.toLowerCase()
      : "";

  if (toolName && toolName !== "bash" && toolName !== "eval") {
    return undefined;
  }

  const cmd = extractCommand(event);
  if (!cmd) return undefined;

  const rule = matchDestructiveCommand(cmd);
  if (!rule) return undefined;

  // Preserve existing headless permissions except identified destructive Git restoration.
  if (!isInteractive || (ctx && typeof ctx === "object" && "hasUI" in ctx && ctx.hasUI === false)) {
    if (!rule.rule?.blockHeadless) return undefined;
    const reason = `Страж удаления: «${rule.what}» требует явного интерактивного подтверждения. Команда заблокирована без UI; не повторяй её, используй изолированный workspace и integrate.`;
    return { block: true, reason, deny: reason };
  }

  let home: string | undefined;
  if (ctx && typeof ctx === "object" && "env" in ctx && ctx.env && typeof ctx.env === "object" && "get" in ctx.env && typeof ctx.env.get === "function") {
    try {
      home = (await ctx.env.get("HOME")) ?? (await ctx.env.get("USERPROFILE"));
    } catch {
      // ignore env read error and use process.env fallback
    }
  }
  if (!home) {
    home = process.env.HOME || process.env.USERPROFILE;
  }

  const scope = await computeRmScope(cmd, ctx, home);

  let confirmed = false;
  const title = "Страж";
  const message = `Агент хочет ${rule.what}${scope}:\n${cmd.slice(0, 200)}\nВыполнить?`;

  if (ctx && typeof ctx === "object" && "ui" in ctx && ctx.ui && typeof ctx.ui === "object") {
    const ui = ctx.ui;
    try {
      if ("confirm" in ui && typeof ui.confirm === "function") {
        confirmed = (await ui.confirm(title, message)) === true;
      } else if ("ask" in ui && typeof ui.ask === "function") {
        const answer = await ui.ask(message, {
          header: title,
          options: ["Отменить", "Выполнить"],
        });
        confirmed = answer === "Выполнить";
      }
    } catch {
      // dialog dismissed or cancelled
      confirmed = false;
    }
  }

  if (confirmed) {
    return undefined;
  }

  const denyText = buildDenyMessage(rule.what);
  return {
    block: true,
    reason: denyText,
    deny: denyText,
  };
}

export function createDeleteGuardExtension() {
  return function deleteGuardExtension(pi: ExtensionAPI): void {
    pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
      handleSessionStart(event, ctx);
    });

    pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
      const result = await handleToolCall(event, ctx);
      return result;
    });
  };
}

export default createDeleteGuardExtension();
