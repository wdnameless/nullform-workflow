/**
 * tools/review/gatekeeper.mjs — pre-call authorization guard for tools.
 *
 * Dangerous categories and explicit tool-name lists:
 *
 * 1. EXEC: Arbitrary command execution and process invocation.
 *    Tools: bash, exec, execute, shell_command, terminal, run_command, spawn.
 *    Risk: arbitrary code execution, escaping workspace isolation, host compromise.
 *
 * 2. WRITE: Filesystem mutation and state-altering modifications.
 *    Tools: write, edit, fast_edit, write_file, edit_file, delete_file, remove_file, patch, create_file.
 *    Risk: overwriting source files, destroying audit records, altering configurations.
 *
 * 3. NETWORK: Outbound communication, web retrieval, and browser automation.
 *    Tools: fetch, http_request, curl, web_search, browser, playwright, crawl4ai, chrome_devtools, git_push, git_fetch, git_clone.
 *    Risk: data exfiltration, unbudgeted network calls, uncontrolled external state.
 *
 * Safe / public tools (read-only): read, grep, glob, lsp, ast_grep, etc.
 *
 * Default policy:
 * - Dangerous tools without an allow entry are denied with rule "default-deny".
 * - Safe tools default to rule "public".
 * - Every decision is appended to an in-memory audit log (accessible via getAuditLog()).
 * - When auditPath is configured, each decision is also appended to that file.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DANGEROUS_EXEC_TOOLS = Object.freeze([
  'bash',
  'exec',
  'execute',
  'shell_command',
  'terminal',
  'run_command',
  'spawn',
]);

export const DANGEROUS_WRITE_TOOLS = Object.freeze([
  'write',
  'edit',
  'fast_edit',
  'write_file',
  'edit_file',
  'delete_file',
  'remove_file',
  'patch',
  'create_file',
]);

export const DANGEROUS_NETWORK_TOOLS = Object.freeze([
  'fetch',
  'http_request',
  'curl',
  'web_search',
  'browser',
  'playwright',
  'crawl4ai',
  'chrome_devtools',
  'git_push',
  'git_fetch',
  'git_clone',
]);

export function getToolCategory(tool) {
  if (typeof tool !== 'string' || !tool) return null;
  const name = tool.toLowerCase().replace(/^xd:\/\//, '').replace(/^mcp__/, '');
  if (DANGEROUS_EXEC_TOOLS.includes(name) || DANGEROUS_EXEC_TOOLS.some(t => name === t || name.startsWith(`${t}_`))) return 'exec';
  if (DANGEROUS_WRITE_TOOLS.includes(name) || DANGEROUS_WRITE_TOOLS.some(t => name === t || name.startsWith(`${t}_`))) return 'write';
  if (DANGEROUS_NETWORK_TOOLS.includes(name) || DANGEROUS_NETWORK_TOOLS.some(t => name === t || name.startsWith(`${t}_`))) return 'network';
  return null;
}

export function isDangerousTool(tool) {
  return getToolCategory(tool) !== null;
}

let configuredAllow = [];
let configuredAuditPath = null;
let auditLog = [];

export function configureGatekeeper({ allow = [], auditPath = null } = {}) {
  configuredAllow = Array.isArray(allow) ? [...allow] : [];
  configuredAuditPath = typeof auditPath === 'string' && auditPath ? auditPath : null;
  auditLog = [];
}

export function clearAuditLog() {
  auditLog = [];
}

export function resetGatekeeper() {
  configuredAllow = [];
  configuredAuditPath = null;
  auditLog = [];
}

export function getAuditLog() {
  return [...auditLog];
}

function recordDecision(tool, decision, args) {
  const entry = {
    tool,
    rule: decision.rule,
    ok: decision.ok,
    timestamp: new Date().toISOString(),
    args: args !== undefined ? args : null,
  };
  auditLog.push(entry);

  if (configuredAuditPath) {
    const dir = dirname(configuredAuditPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(configuredAuditPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

export function authorize(tool, args) {
  if (typeof tool !== 'string' || !tool) {
    const decision = { ok: false, rule: 'invalid-tool' };
    recordDecision(tool, decision, args);
    return decision;
  }

  const category = getToolCategory(tool);
  const dangerous = category !== null;

  for (const entry of configuredAllow) {
    if (!entry) continue;
    const toolMatch = entry.tool === '*'
      || entry.tool === tool
      || (category && entry.tool === category)
      || (typeof entry.tool === 'string' && entry.tool.toLowerCase() === tool.toLowerCase());

    if (toolMatch) {
      if (typeof entry.check === 'function') {
        try {
          if (!entry.check(args)) continue;
        } catch {
          continue;
        }
      }
      if (typeof entry.rule === 'function') {
        try {
          const res = entry.rule(args);
          if (res === false) {
            const decision = { ok: false, rule: entry.rule.name || 'custom-deny' };
            recordDecision(tool, decision, args);
            return decision;
          }
          if (res === true) {
            const decision = { ok: true, rule: entry.rule.name || 'custom-allow' };
            recordDecision(tool, decision, args);
            return decision;
          }
          if (res && typeof res === 'object') {
            const decision = { ok: Boolean(res.ok), rule: res.rule || (res.ok ? 'custom-allow' : 'custom-deny') };
            recordDecision(tool, decision, args);
            return decision;
          }
          if (typeof res === 'string') {
            const decision = { ok: true, rule: res };
            recordDecision(tool, decision, args);
            return decision;
          }
        } catch {
          const decision = { ok: false, rule: 'rule-evaluation-error' };
          recordDecision(tool, decision, args);
          return decision;
        }
      }
      const ruleName = typeof entry.rule === 'string' ? entry.rule : 'allow';
      const decision = { ok: true, rule: ruleName };
      recordDecision(tool, decision, args);
      return decision;
    }
  }

  if (dangerous) {
    const decision = { ok: false, rule: 'default-deny' };
    recordDecision(tool, decision, args);
    return decision;
  }

  const decision = { ok: true, rule: 'public' };
  recordDecision(tool, decision, args);
  return decision;
}

/**
 * assertFactForcing — requires prior reads of callers/consumers before an edit.
 * Throws an error naming any missing required read paths.
 *
 * @param {string} target - The path or identifier being edited.
 * @param {{ reads?: string[], required?: string[] }} evidence - Read paths and required caller/consumer paths.
 */
export function assertFactForcing(target, evidence = {}) {
  const reads = new Set(Array.isArray(evidence?.reads) ? evidence.reads : []);
  const required = Array.isArray(evidence?.required) ? evidence.required : [];
  const missing = required.filter((path) => !reads.has(path));
  if (missing.length > 0) {
    throw new Error(
      `Fact-forcing check failed for "${target}": missing required reads: ${missing.join(', ')}`
    );
  }
}
