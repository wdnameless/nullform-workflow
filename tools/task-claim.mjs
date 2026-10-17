/**
 * tools/task-claim.mjs — Durable exactly-one-writer task claims + goal-ancestry context packets.
 *
 * Design ported from paperclip's atomic checkout + heartbeat-context (MIT, paperclipai/paperclip,
 * pinned 9f4a956b): one owner per task, explicit refusal for the second writer, and a cold-start
 * packet carrying goal ancestry, scope, non-goals, state evidence and verification commands.
 * Storage is the existing .workflow/ directory; no new service, DB, or dependency.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";

const DIR = ".workflow";
const CLAIMS_DIR = "claims";
const TASK_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function claimsDir(root) {
  return join(resolve(root), DIR, CLAIMS_DIR);
}

function claimPath(root, task) {
  if (typeof task !== "string" || !TASK_ID.test(task)) {
    throw new Error("--task must be a lowercase alphanumeric/hyphen slug (1-64 characters)");
  }
  return join(claimsDir(root), `${task}.json`);
}

function ensureClaimsDir(root) {
  const dir = claimsDir(root);
  mkdirSync(join(resolve(root), DIR), { recursive: true });
  try {
    mkdirSync(dir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Claims directory is a symlink/junction");
  return dir;
}

function readClaimFile(path) {
  const body = readFileSync(path, "utf8");
  const record = JSON.parse(body);
  if (
    record.version !== 1 ||
    typeof record.task !== "string" ||
    typeof record.owner !== "string" ||
    !record.owner ||
    typeof record.token !== "string" ||
    typeof record.startedAt !== "string" ||
    (record.endsAt !== null && typeof record.endsAt !== "string")
  ) {
    throw new Error("Malformed task claim record");
  }
  return { record, body };
}

/**
 * Claim a task for exactly one writer. Second writer gets an explicit refusal (never retry).
 * Returns the claim record on success; throws with code ECLAIMED when already held.
 */
export function claimTask(root, task, owner) {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 256 || /[\x00-\x1f\x7f]/.test(owner)) {
    throw new Error("--owner must be a non-empty bounded identity string");
  }
  ensureClaimsDir(root);
  const path = claimPath(root, task);
  const record = {
    version: 1,
    task,
    owner: owner.trim(),
    token: randomUUID(),
    startedAt: new Date().toISOString(),
    endsAt: null,
  };
  try {
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let holder = "unreadable record";
    try {
      const { record: existing } = readClaimFile(path);
      holder = `owner=${existing.owner}, token=${existing.token}, startedAt=${existing.startedAt}`;
    } catch {}
    const err = new Error(`Task "${task}" is already claimed. Holder: ${holder}. Pick a different task; never retry a refusal.`);
    err.code = "ECLAIMED";
    throw err;
  }
  return record;
}

/**
 * Release a claim. Requires the claim token: only the holder (or an operator who
 * re-read the unchanged record) may release. EndsAt is stamped, record is kept.
 */
export function releaseTask(root, task, token) {
  ensureClaimsDir(root);
  const path = claimPath(root, task);
  if (!existsSync(path)) {
    const err = new Error(`No active claim for task "${task}"`);
    err.code = "ENOCLAIM";
    throw err;
  }
  const { record } = readClaimFile(path);
  if (record.endsAt) {
    const err = new Error(`Claim for task "${task}" already ended at ${record.endsAt}`);
    err.code = "EENDED";
    throw err;
  }
  if (record.token !== token) {
    const err = new Error(`Claim token mismatch for task "${task}": refusing release without holder proof`);
    err.code = "ETOKEN";
    throw err;
  }
  record.endsAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return record;
}

export function readClaim(root, task) {
  const path = claimPath(root, task);
  if (!existsSync(path)) return null;
  return readClaimFile(path).record;
}

function readBounded(root, rel, maxBytes = 65536) {
  const full = resolve(root, rel);
  if (relative(resolve(root), full).startsWith("..")) throw new Error(`Path escapes project root: ${rel}`);
  if (!existsSync(full) || !lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) return null;
  const text = readFileSync(full, "utf8");
  return text.length > maxBytes ? text.slice(0, maxBytes) + "\n…[truncated]" : text;
}

function requirementRows(manifestText) {
  if (!manifestText) return [];
  return manifestText
    .split("\n")
    .filter((line) => /^\|\s*R\d+/i.test(line))
    .slice(0, 64);
}

/**
 * Build a cold-start context packet: goal ancestry, scope, non-goals, state evidence,
 * verification commands. Generated from manifest/spec/tasks, never invented.
 */
export function contextPacket(root, { change, task = null } = {}) {
  if (typeof change !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(change)) {
    throw new Error("--change must be an alphanumeric slug");
  }
  const base = `openspec/changes/${change}`;
  const manifest = readBounded(root, `${base}/manifest.md`);
  const proposal = readBounded(root, `${base}/proposal.md`, 8192);
  const tasks = readBounded(root, `${base}/tasks.md`, 16384);
  if (!manifest) throw new Error(`Missing ${base}/manifest.md: cannot build a context packet without requirements`);
  const claim = task ? readClaim(root, task) : null;
  if (task && !claim) throw new Error(`No claim record for task "${task}": claim it first`);
  return {
    version: 1,
    change,
    task,
    claim: claim ? { owner: claim.owner, token: claim.token, startedAt: claim.startedAt, endsAt: claim.endsAt } : null,
    goalAncestry: {
      proposal: proposal ? proposal.slice(0, 2000) : null,
      requirements: requirementRows(manifest),
    },
    scope: { tasks: tasks ? tasks.slice(0, 8000) : null },
    nonGoals: [
      "Do not edit files outside the claimed scope.",
      "Do not invent requirements, metrics, or acceptance criteria.",
      "Do not claim verification you did not execute.",
    ],
    verification: [
      "Run the task's stated acceptance check and quote raw output with exit codes.",
      "Keep unrelated tests green; report any failure verbatim.",
    ],
  };
}

export function runClaimCommand(command, root, flags) {
  try {
    if (command === "claim") {
      if (typeof flags.task !== "string" || typeof flags.owner !== "string") {
        throw new Error("Use --task SLUG --owner IDENTITY");
      }
      const record = claimTask(root, flags.task, flags.owner);
      console.log(JSON.stringify({ ok: true, claim: record }, null, 2));
      return 0;
    }
    if (command === "release") {
      if (typeof flags.task !== "string" || typeof flags.token !== "string") {
        throw new Error("Use --task SLUG --token TOKEN");
      }
      const record = releaseTask(root, flags.task, flags.token);
      console.log(JSON.stringify({ ok: true, released: record }, null, 2));
      return 0;
    }
    if (command === "context") {
      if (typeof flags.change !== "string") throw new Error("Use --change SLUG [--task SLUG]");
      const packet = contextPacket(root, { change: flags.change, task: flags.task });
      console.log(JSON.stringify(packet, null, 2));
      return 0;
    }
    throw new Error(`Unknown claim command "${command}"`);
  } catch (err) {
    console.error(`workflow ${command} error: ${err.message}`);
    return err.code === "ECLAIMED" ? 3 : 1;
  }
}
