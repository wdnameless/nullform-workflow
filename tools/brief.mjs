import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Redact token-shaped secrets to [REDACTED:<NAME>] placeholders.
 */
export function redactSecrets(text) {
  if (typeof text !== "string") return String(text ?? "");
  let out = text;
  // Connection strings (postgres, mysql, mongodb, redis, amqp, etc.)
  out = out.replace(/(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s"'`<>]+/gi, "[REDACTED:CONNECTION_STRING]");
  // Telegram bot tokens (e.g. 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345678)
  out = out.replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[REDACTED:TELEGRAM_TOKEN]");
  // JWT tokens (eyJ...)
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._~+/-]+\b/g, "[REDACTED:JWT]");
  // AWS access key IDs (AKIA..., ASIA...)
  out = out.replace(/\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED:AWS_KEY]");
  // Slack tokens (xoxb-, xoxa-, xoxp-, xoxo-, xoxr-)
  out = out.replace(/\bxox[abpor]-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED:SLACK_TOKEN]");
  // GitHub tokens (ghp_...)
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "[REDACTED:GITHUB_TOKEN]");
  // sk- API keys (OpenAI, Anthropic, etc.)
  out = out.replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:SK_KEY]");
  // GitHub fine-grained PATs (github_pat_...) and GitLab PATs (glpat-...)
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, "[REDACTED:GITHUB_TOKEN]");
  out = out.replace(/\bglpat-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED:GITLAB_TOKEN]");
  // Google API keys (AIza...)
  out = out.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:GOOGLE_KEY]");
  // PEM private key blocks (full block first, then lone headers)
  out = out.replace(/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED:PRIVATE_KEY_BLOCK]");
  out = out.replace(/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED:PRIVATE_KEY]");
  // Bearer tokens (after JWT: "Bearer [REDACTED:JWT]" must survive via lookahead)
  out = out.replace(/\bBearer\s+(?!\[REDACTED)([A-Za-z0-9._~+/-]{10,})\b/g, "Bearer [REDACTED:BEARER_TOKEN]");
  // Generic api_key assignments (value only, quotes preserved)
  out = out.replace(/(?<=\bapi[_-]?key\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]{8,}(?=["']?(?:\s|$))/gi, "[REDACTED:API_KEY]");
  return out;
}

/**
 * Freeze a brief into a dated <YYYY-MM-DD>-brief.md file with redactions applied
 * before disk write. Refuses overwrite if a brief already exists.
 */
export function freezeBrief(dir, text) {
  mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const filename = `${today}-brief.md`;
  const filePath = join(dir, filename);
  const existing = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-brief\.md$/.test(f) || f.endsWith("-brief.md"))
    : [];
  if (existing.length > 0 || existsSync(filePath)) {
    throw new Error(`Refusing overwrite of existing frozen brief in: ${dir}`);
  }
  const redacted = redactSecrets(text);
  writeFileSync(filePath, redacted, { encoding: "utf8", flag: "wx" });
  return filePath;
}

/**
 * Return the path to the frozen brief inside changeDir.
 * Throws when missing or ambiguous.
 */
export function oracleInput(changeDir) {
  if (!changeDir || !existsSync(changeDir)) {
    throw new Error(`Frozen brief missing: directory does not exist (${changeDir})`);
  }
  const files = readdirSync(changeDir);
  const briefs = files.filter((f) => /^\d{4}-\d{2}-\d{2}-brief\.md$/.test(f) || f.endsWith("-brief.md"));
  if (briefs.length === 0) {
    throw new Error(`Frozen brief missing in: ${changeDir}`);
  }
  if (briefs.length > 1) {
    throw new Error(`Ambiguous frozen brief in ${changeDir}: multiple briefs found (${briefs.join(", ")})`);
  }
  return join(changeDir, briefs[0]);
}
