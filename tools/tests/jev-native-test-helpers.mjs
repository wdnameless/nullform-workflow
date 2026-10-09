import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
let _bunAvailable;
export function isBunAvailable() {
  if (_bunAvailable === undefined) {
    try {
      const res = spawnSync("bun", ["--version"], { stdio: "ignore" });
      _bunAvailable = !res.error && res.status === 0;
    } catch {
      _bunAvailable = false;
    }
  }
  return _bunAvailable;
}

export function runBunTest(arg1, arg2) {
  let t = null;
  let testCode = "";
  if (typeof arg1 === "string") {
    testCode = arg1;
    t = arg2;
  } else {
    t = arg1;
    testCode = arg2;
  }

  if (!isBunAvailable()) {
    if (t && typeof t.skip === "function") {
      t.skip("bun not in PATH");
      return;
    }
    return;
  }
  const fullCode = `
import assert from "node:assert/strict";
import jevExtensionFactory, { createJevExtension, getEffectiveNativeSkills } from "./agent/extensions/nullform-jev.ts";

function createMockPi(handlers, overrides = {}) {
  return {
    on(event, handler) { handlers.set(event, handler); },
    getCommands: () => [
      { source: "skill", name: "skill:test-skill", description: "A very long detailed raw skill description that must not be emitted", path: "/path/test-skill" },
    ],
    ...overrides,
  };
}

function createMockCore(overrides = {}) {
  return {
    async readCredential() { return "test-api-key"; },
    async loadSkillCatalog({ effectiveSkills } = {}) {
      return {
        skills: effectiveSkills || [{ name: "test-skill", description: "A very long detailed raw skill description that must not be emitted" }],
        fingerprint: "cat-fp-1",
      };
    },
    screenTask(text) { return { allowed: true, reason: "" }; },
    async decide() {
      return {
        status: "ok",
        reason: "matched",
        skill: "test-skill",
        confidence: 0.95,
        model: "typesafe/jev-1.13",
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001, costKnown: true },
      };
    },
    readPolicy() {
      return {
        version: 2,
        enabled: true,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        catalogFingerprint: "cat-fp-1",
        baselineModel: "google/gemini-3.8-flash",
        decisionModel: "typesafe/jev-1.13",
        fingerprint: "fp-1",
        reportSha256: "sha-1",
        decisionSnapshots: ["typesafe/jev-1.13"],
        skillPassed: true,
      };
    },
    appendEvent() {},
    ...overrides,
  };
}

${testCode}
`;
  const res = spawnSync("bun", ["-e", fullCode], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
  });
  assert.equal(res.status, 0, `Bun execution failed:\nSTDOUT: ${res.stdout}\nSTDERR: ${res.stderr}`);
}
