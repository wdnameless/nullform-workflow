import { createHash } from "node:crypto";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const VALID_EFFECTS = new Set(["SE0", "SE1", "SE2", "SE3", "SE4"]);

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
  return `{${pairs.join(",")}}`;
}

function readLastReceipt(logPath) {
  if (!existsSync(logPath)) return null;
  const content = readFileSync(logPath, "utf8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]);
}

export function appendReceipt(logPath, entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("Invalid receipt entry: must be an object");
  }

  const effect = entry.effect;
  if (!VALID_EFFECTS.has(effect)) {
    throw new Error(`Invalid effect class "${effect}": must be one of ${Array.from(VALID_EFFECTS).join(", ")}`);
  }

  const body = "body" in entry ? entry.body : (({ effect: _, seq: _s, prev: _p, hash: _h, ...rest }) => rest)(entry);

  const last = readLastReceipt(logPath);
  const seq = entry.seq !== undefined ? entry.seq : (last ? last.seq + 1 : 0);
  const prev = entry.prev !== undefined ? entry.prev : (last ? last.hash : "");

  const canonicalEntry = canonicalJson({ effect, body });
  const hash = createHash("sha256").update(prev + canonicalEntry, "utf8").digest("hex");

  const receipt = { seq, prev, hash, effect, body };

  mkdirSync(dirname(resolve(logPath)), { recursive: true });
  appendFileSync(logPath, JSON.stringify(receipt) + "\n", "utf8");
  return receipt;
}

export function verifyChain(logPath) {
  if (!existsSync(logPath)) {
    return { ok: true, count: 0 };
  }

  const content = readFileSync(logPath, "utf8");
  const rawLines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) {
    return { ok: true, count: 0 };
  }

  let expectedPrev = "";
  let expectedSeq = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    let receipt;
    try {
      receipt = JSON.parse(raw);
    } catch {
      throw new Error(`Broken chain at seq ${expectedSeq}: invalid JSON at line ${i + 1}`);
    }

    const currentSeq = typeof receipt.seq === "number" ? receipt.seq : expectedSeq;

    if (receipt.seq !== expectedSeq) {
      throw new Error(`Broken chain at seq ${currentSeq}: expected seq ${expectedSeq}, got ${receipt.seq}`);
    }

    if (!VALID_EFFECTS.has(receipt.effect)) {
      throw new Error(`Broken chain at seq ${currentSeq}: invalid effect "${receipt.effect}"`);
    }

    if (receipt.prev !== expectedPrev) {
      throw new Error(`Broken chain at seq ${currentSeq}: prev hash mismatch, expected "${expectedPrev}", got "${receipt.prev}"`);
    }

    const canonicalEntry = canonicalJson({ effect: receipt.effect, body: receipt.body });
    const expectedHash = createHash("sha256").update(receipt.prev + canonicalEntry, "utf8").digest("hex");

    if (receipt.hash !== expectedHash) {
      throw new Error(`Broken chain at seq ${currentSeq}: hash mismatch, expected ${expectedHash}, got ${receipt.hash}`);
    }

    expectedPrev = receipt.hash;
    expectedSeq++;
  }

  return { ok: true, count: rawLines.length };
}
