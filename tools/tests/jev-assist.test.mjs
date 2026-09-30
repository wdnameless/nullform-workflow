/**
 * tools/tests/jev-assist.test.mjs
 * Behavioral tests for JEV automatic assistance core runtime:
 * - R01: Effective skill catalog loading, frontmatter parsing, duplicate precedence, operator disabled filtering, deterministic fingerprint.
 * - R03: Secure credential lookup (env / native store), zero credential leakage in logs or reports.
 * - R04: Task screening (secrets, PII, email, code dump, continuation, risk), no outbound traffic on failure, safe fallback.
 * - R06: Strict report evaluation recomputing hurdles from raw case arrays, policy validation with SHA-256 and fingerprint matching.
 * - R07: Bounded Decisions client, typed answers, allow-listed skills only, zero tier downgrade, redacted telemetry.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
  readCredential,
  loadSkillCatalog,
  screenTask,
  decide,
  policyFingerprint,
  evaluateReport,
  readPolicy,
  appendEvent,
} from "../jev-assist.mjs";

function createTempDir(prefix = "jev-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1. readCredential
// ---------------------------------------------------------------------------

test("readCredential: reads OPENROUTER_API_KEY from environment with trimming", async () => {
  const origOpenRouter = process.env.OPENROUTER_API_KEY;
  const origJev = process.env.JEV_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = "  sk-or-v1-testkey1234567890  ";
    delete process.env.JEV_API_KEY;
    const cred = await readCredential();
    assert.equal(cred, "sk-or-v1-testkey1234567890");
  } finally {
    if (origOpenRouter !== undefined) process.env.OPENROUTER_API_KEY = origOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
    if (origJev !== undefined) process.env.JEV_API_KEY = origJev;
    else delete process.env.JEV_API_KEY;
  }
});

test("readCredential: falls back to JEV_API_KEY when OPENROUTER_API_KEY is unset", async () => {
  const origOpenRouter = process.env.OPENROUTER_API_KEY;
  const origJev = process.env.JEV_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    process.env.JEV_API_KEY = "jev-key-xyz-9876543210";
    const cred = await readCredential();
    assert.equal(cred, "jev-key-xyz-9876543210");
  } finally {
    if (origOpenRouter !== undefined) process.env.OPENROUTER_API_KEY = origOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
    if (origJev !== undefined) process.env.JEV_API_KEY = origJev;
    else delete process.env.JEV_API_KEY;
  }
});

test("readCredential: returns null when env keys are absent or empty in pure Node", async () => {
  const origOpenRouter = process.env.OPENROUTER_API_KEY;
  const origJev = process.env.JEV_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.JEV_API_KEY;
    const cred = await readCredential();
    assert.equal(cred, null);
  } finally {
    if (origOpenRouter !== undefined) process.env.OPENROUTER_API_KEY = origOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
    if (origJev !== undefined) process.env.JEV_API_KEY = origJev;
    else delete process.env.JEV_API_KEY;
  }
});

// ---------------------------------------------------------------------------
// 2. loadSkillCatalog
// ---------------------------------------------------------------------------

test("loadSkillCatalog: loads effective skills, parses frontmatter and honors disabled list", () => {
  const tmp = createTempDir("skills-cat-");
  try {
    const projectDir = join(tmp, "project");
    const userHome = join(tmp, "home");
    const projSkills = join(projectDir, ".agents", "skills");
    const homeSkills = join(userHome, ".agents", "skills");

    mkdirSync(join(projSkills, "skill-alpha"), { recursive: true });
    writeFileSync(
      join(projSkills, "skill-alpha", "SKILL.md"),
      `---\nname: skill-alpha\ndescription: "Alpha skill description"\n---\n# Full alpha body\nDo not leak body\n`,
      "utf8"
    );

    mkdirSync(join(projSkills, "skill-disabled"), { recursive: true });
    writeFileSync(
      join(projSkills, "skill-disabled", "SKILL.md"),
      `---\nname: skill-disabled\ndescription: "Disabled skill description"\n---\n# Body\n`,
      "utf8"
    );

    mkdirSync(join(homeSkills, "skill-beta"), { recursive: true });
    writeFileSync(
      join(homeSkills, "skill-beta", "SKILL.md"),
      `---\nname: skill-beta\ndescription: "Beta skill from home"\n---\n# Body beta\n`,
      "utf8"
    );

    writeFileSync(
      join(projectDir, ".agents", ".skills-disabled.json"),
      JSON.stringify({ version: 1, disabled: ["skill-disabled"] }),
      "utf8"
    );

    const catalog = loadSkillCatalog({ cwd: projectDir, home: userHome });
    assert.ok(Array.isArray(catalog.skills));
    assert.equal(typeof catalog.fingerprint, "string");
    assert.ok(catalog.fingerprint.length > 0);

    const names = catalog.skills.map((s) => s.name);
    assert.ok(names.includes("skill-alpha"));
    assert.ok(names.includes("skill-beta"));
    assert.ok(!names.includes("skill-disabled"), "Disabled skill must be filtered out");

    const alpha = catalog.skills.find((s) => s.name === "skill-alpha");
    assert.equal(alpha.description, "Alpha skill description");
    assert.equal(alpha.body, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadSkillCatalog: duplicate skill in earlier root takes precedence and fingerprint changes on metadata", () => {
  const tmp = createTempDir("skills-prec-");
  try {
    const rootA = join(tmp, "rootA");
    const rootB = join(tmp, "rootB");

    mkdirSync(join(rootA, "skill-shared"), { recursive: true });
    writeFileSync(
      join(rootA, "skill-shared", "SKILL.md"),
      `---\nname: skill-shared\ndescription: "Description from root A"\n---\n`,
      "utf8"
    );

    mkdirSync(join(rootB, "skill-shared"), { recursive: true });
    writeFileSync(
      join(rootB, "skill-shared", "SKILL.md"),
      `---\nname: skill-shared\ndescription: "Description from root B"\n---\n`,
      "utf8"
    );

    const cat1 = loadSkillCatalog({ cwd: tmp, home: tmp, roots: [rootA, rootB] });
    assert.equal(cat1.skills.length, 1);
    assert.equal(cat1.skills[0].description, "Description from root A");

    writeFileSync(
      join(rootA, "skill-shared", "SKILL.md"),
      `---\nname: skill-shared\ndescription: "Changed description root A"\n---\n`,
      "utf8"
    );
    const cat2 = loadSkillCatalog({ cwd: tmp, home: tmp, roots: [rootA, rootB] });
    assert.notEqual(cat1.fingerprint, cat2.fingerprint, "Fingerprint must change when metadata changes");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadSkillCatalog: allows semantic security descriptions but drops skills with raw secret tokens", () => {
  const tmp = createTempDir("skills-sec-");
  try {
    const root = join(tmp, "skills");
    mkdirSync(join(root, "security-review"), { recursive: true });
    writeFileSync(
      join(root, "security-review", "SKILL.md"),
      `---\nname: security-review\ndescription: "Audit code for authentication and security review"\n---\n`,
      "utf8"
    );

    mkdirSync(join(root, "leaky-skill"), { recursive: true });
    writeFileSync(
      join(root, "leaky-skill", "SKILL.md"),
      `---\nname: leaky-skill\ndescription: "Connects with sk-or-v1-abcdef01234567890123456789"\n---\n`,
      "utf8"
    );

    const cat = loadSkillCatalog({ cwd: tmp, home: tmp, roots: [root] });
    const names = cat.skills.map((s) => s.name);
    assert.ok(names.includes("security-review"), "Semantic security description must be preserved");
    assert.ok(!names.includes("leaky-skill"), "Skill with raw secret token in description must be dropped");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. screenTask
// ---------------------------------------------------------------------------

test("screenTask: screens invalid and empty inputs", () => {
  assert.equal(screenTask("").allowed, false);
  assert.equal(screenTask("   \n\t").allowed, false);
  assert.equal(screenTask(null).allowed, false);
  assert.equal(screenTask(undefined).allowed, false);
});

test("screenTask: confirmed repro - rejects email PII", () => {
  const res = screenTask("Classify this contact: sample-person@private-example.invalid");
  assert.equal(res.allowed, false);
  assert.equal(res.reason, "pii");
});

test("screenTask: detects secrets and canaries", () => {
  assert.equal(screenTask("Here is my key: sk-or-v1-1234567890abcdef123456").allowed, false);
  assert.equal(screenTask("Private key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...").allowed, false);
  assert.equal(screenTask("Use password: mysecretpassword123 for database").allowed, false);
  assert.equal(screenTask("API_KEY = abcdef0123456789").allowed, false);
});

test("screenTask: privacy extensions (password URLs, AWS secrets, GitHub PATs, AIza, xox, JWT, Bearer)", () => {
  assert.equal(screenTask("Database at postgres://admin:supersecret@db.internal:5432/main").allowed, false);
  assert.equal(screenTask("AWS key: aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY").allowed, false);
  assert.equal(screenTask("GitHub token: github_pat_11ABCD0123456789012345_abcdef01234567890123456789012345678901234567890123456789012345").allowed, false);
  assert.equal(screenTask("Google API key: AIzaSyD1234567890abcdefghijklmnopqrstuv").allowed, false);
  assert.equal(screenTask("Slack token: xoxb-1234567890-abcdef123456").allowed, false);
  assert.equal(screenTask("Bearer token: Authorization: Bearer abcdef0123456789abcdef0123456789").allowed, false);
  assert.equal(screenTask("JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c").allowed, false);
});

test("screenTask: detects PII", () => {
  assert.equal(screenTask("Customer card is 4111-2222-3333-4444 please charge").allowed, false);
  assert.equal(screenTask("User SSN: 123-45-6789").allowed, false);
});

test("screenTask: detects large and small code dumps, diffs, and attachments", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) {
    lines.push(`+ const line_${i} = doSomethingWith(${i});`);
  }
  const dump = "```typescript\n" + lines.join("\n") + "\n```";
  assert.equal(screenTask(dump).allowed, false);
  assert.equal(screenTask(dump).reason, "code-dump");

  const diffDump = "diff --git a/foo.js b/foo.js\n--- a/foo.js\n+++ b/foo.js\n@@ -1,3 +1,3 @@\n-old\n+new\n@@ -10,3 +10,3 @@\n-x\n+y";
  assert.equal(screenTask(diffDump).allowed, false);
  assert.equal(screenTask(diffDump).reason, "code-dump");

  const dataUrl = "Attachment: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  assert.equal(screenTask(dataUrl).allowed, false);
  assert.equal(screenTask(dataUrl).reason, "code-dump");
});

test("screenTask: detects continuation-only and context-dependent tasks", () => {
  assert.equal(screenTask("continue").allowed, false);
  assert.equal(screenTask("продолжай").allowed, false);
  assert.equal(screenTask("same as above").allowed, false);
  assert.equal(screenTask("как выше").allowed, false);
  assert.equal(screenTask("do it again").allowed, false);
});

test("screenTask: detects risky destructive requests", () => {
  assert.equal(screenTask("run rm -rf /var/data to clean up").allowed, false);
  assert.equal(screenTask("DROP DATABASE production;").allowed, false);
  assert.equal(screenTask("cat /etc/shadow").allowed, false);
});

test("screenTask: allows safe leaf tasks and semantic security phrases", () => {
  const safe1 = screenTask("Format and sort JSON keys in package.json");
  assert.equal(safe1.allowed, true);
  assert.equal(safe1.reason, "ok");

  const safe2 = screenTask("Look up status code 404 in http documentation");
  assert.equal(safe2.allowed, true);

  const safe3 = screenTask("Run security review for authentication module interfaces");
  assert.equal(safe3.allowed, true);
});

// ---------------------------------------------------------------------------
// 4. decide
// ---------------------------------------------------------------------------

test("decide: returns fallback and zero traffic on screened task (secret canary)", async () => {
  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    throw new Error("Should not be called");
  };

  const res = await decide({
    task: "Please use sk-or-v1-abcdef0123456789012345 to fetch user",
    skills: [{ name: "lookup", description: "Search" }],
    apiKey: "dummy-key",
    fetchImpl: mockFetch,
  });

  assert.equal(fetchCalled, false, "Screened task must not generate network traffic");
  assert.equal(res.status, "fallback");
  assert.match(res.reason, /^screened:/);
  assert.equal(res.route, "baseline");
  assert.equal(res.skill, null);
  assert.equal(res.archetype, "none");
});

test("decide: returns fallback on missing API key with zero traffic", async () => {
  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    return {};
  };

  const res = await decide({
    task: "Sort this json file",
    skills: [{ name: "json-transform", description: "Transform json" }],
    apiKey: "",
    fetchImpl: mockFetch,
  });

  assert.equal(fetchCalled, false);
  assert.equal(res.status, "fallback");
  assert.equal(res.reason, "missing-key");
  assert.equal(res.route, "baseline");
});

test("decide: handles successful API decision with valid skill and cheap leaf archetype", async () => {
  let requestedUrl = "";
  let requestHeaders = null;
  let requestBody = null;

  const mockFetch = async (url, opts) => {
    requestedUrl = url;
    requestHeaders = opts.headers;
    requestBody = JSON.parse(opts.body);
    return {
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13-20260917",
        answers: {
          skill: {
            choice: "formatting",
            confidence: 0.95,
          },
          eligible: {
            noul: 0.96, // Conservative eligibility hurdle >= 0.95
          },
          archetype: {
            choice: "formatting",
            confidence: 0.92, // Archetype confidence >= 0.90
          },
        },
        usage: {
          input_tokens: 350,
          output_tokens: 45,
          cost: 0.0000147,
        },
      }),
    };
  };

  const res = await decide({
    task: "Format code indentation in config.json",
    skills: [
      { name: "formatting", description: "Format code" },
      { name: "lookup", description: "Look up info" },
    ],
    apiKey: "test-openrouter-key",
    fetchImpl: mockFetch,
  });

  assert.equal(requestedUrl, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(requestHeaders["Authorization"], "Bearer test-openrouter-key");
  assert.equal(requestBody.model, "typesafe/jev-1.13");
  assert.equal(requestBody.state.task, "Format code indentation in config.json");
  assert.ok(requestBody.questions.skill);
  assert.ok(requestBody.questions.eligible);
  assert.ok(requestBody.questions.archetype);

  assert.equal(res.status, "ok");
  assert.equal(res.skill, "formatting");
  assert.equal(res.route, "cheap");
  assert.equal(res.archetype, "formatting");
  assert.equal(res.confidence >= 0.9, true);
  assert.equal(res.usage.inputTokens, 350);
  assert.equal(res.usage.outputTokens, 45);
  assert.equal(res.usage.costUsd, 0.0000147);
  assert.equal(res.usage.costKnown, true);
  assert.equal(res.eligibleScore, 0.96);
  assert.equal(res.skillConfidence, 0.95);
  assert.equal(res.routingConfidence, 0.92);
  assert.equal(res.eligibility, undefined, "Must never return eligibility alias");
});

test("decide: choice 'none' maps skill to null", async () => {
  const mockFetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      model: "typesafe/jev-1.13",
      answers: {
        skill: { choice: "none", confidence: 0.88 },
        eligible: { noul: 0.1 },
        archetype: { choice: "none", confidence: 0.8 },
      },
      usage: { input_tokens: 200, output_tokens: 20, cost: 0.00001 },
    }),
  });

  const res = await decide({
    task: "General reasoning question about life",
    skills: [{ name: "lookup", description: "Look up info" }],
    apiKey: "test-key",
    fetchImpl: mockFetch,
  });

  assert.equal(res.status, "ok");
  assert.equal(res.skill, null);
  assert.equal(res.route, "baseline");
  assert.equal(res.archetype, "none");
});

test("decide: invented skill from provider is rejected as invalid response", async () => {
  const mockFetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      model: "typesafe/jev-1.13",
      answers: {
        skill: { choice: "hallucinated-invented-skill", confidence: 0.99 },
        eligible: { noul: 0.96 },
        archetype: { choice: "lookup", confidence: 0.92 },
      },
      usage: { input_tokens: 150, output_tokens: 30, cost: 0.00001 },
    }),
  });

  const res = await decide({
    task: "Find file by name",
    skills: [{ name: "lookup", description: "Look up info" }],
    apiKey: "test-key",
    fetchImpl: mockFetch,
  });

  assert.equal(res.status, "fallback", "Invented skill must fall back");
  assert.equal(res.reason, "invalid-response");
  assert.equal(res.skill, null);
  assert.equal(res.route, "baseline");
});

test("decide: provider error falls back safely without leaking response body", async () => {
  const mockFetch = async () => ({
    status: 500,
    ok: false,
    text: async () => "Internal server database failure at postgres://admin:secret@db.internal",
  });

  const res = await decide({
    task: "Lookup file path",
    skills: [{ name: "lookup", description: "Look up info" }],
    apiKey: "test-key",
    fetchImpl: mockFetch,
  });

  assert.equal(res.status, "fallback");
  assert.equal(res.route, "baseline");
  assert.equal(res.skill, null);
  assert.equal(res.reason, "http-500");
  assert.ok(!res.reason.includes("secret"), "Never echo provider error body");
});

test("decide: confirmed repro - rejects out-of-bounds noul, confidence, empty usage, and unknown archetype", async () => {
  // 1. eligible.noul = 2 (outside 0..1)
  const resBadNoul = await decide({
    task: "Sort this json list",
    skills: [{ name: "json-transform", description: "Transform json" }],
    apiKey: "test-key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        answers: {
          skill: { choice: "json-transform", confidence: 0.95 },
          eligible: { noul: 2 },
          archetype: { choice: "json-transform", confidence: 0.95 },
        },
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
      }),
    }),
  });
  assert.equal(resBadNoul.status, "fallback");
  assert.equal(resBadNoul.reason, "invalid-response");

  // 2. skill.confidence = 999 (outside 0..1)
  const resBadConf = await decide({
    task: "Sort this json list",
    skills: [{ name: "json-transform", description: "Transform json" }],
    apiKey: "test-key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        answers: {
          skill: { choice: "json-transform", confidence: 999 },
          eligible: { noul: 0.96 },
          archetype: { choice: "json-transform", confidence: 0.95 },
        },
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
      }),
    }),
  });
  assert.equal(resBadConf.status, "fallback");
  assert.equal(resBadConf.reason, "invalid-response");

  // 3. usage: {} (missing tokens and cost)
  const resEmptyUsage = await decide({
    task: "Sort this json list",
    skills: [{ name: "json-transform", description: "Transform json" }],
    apiKey: "test-key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        answers: {
          skill: { choice: "json-transform", confidence: 0.95 },
          eligible: { noul: 0.96 },
          archetype: { choice: "json-transform", confidence: 0.95 },
        },
        usage: {},
      }),
    }),
  });
  assert.equal(resEmptyUsage.status, "fallback");
  assert.equal(resEmptyUsage.reason, "invalid-response");

  // 4. Unknown archetype
  const resUnknownArch = await decide({
    task: "Sort this json list",
    skills: [{ name: "json-transform", description: "Transform json" }],
    apiKey: "test-key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        answers: {
          skill: { choice: "json-transform", confidence: 0.95 },
          eligible: { noul: 0.96 },
          archetype: { choice: "arbitrary-arch", confidence: 0.95 },
        },
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
      }),
    }),
  });
  assert.equal(resUnknownArch.status, "fallback");
  assert.equal(resUnknownArch.reason, "invalid-response");
});

test("decide: conservative thresholds - low eligibility or low archetype confidence retains baseline route", async () => {
  // Eligibility 0.94 (< 0.95 threshold)
  const resLowElig = await decide({
    task: "Format code indentation in config.json",
    skills: [{ name: "formatting", description: "Format code" }],
    apiKey: "test-key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        answers: {
          skill: { choice: "formatting", confidence: 0.98 },
          eligible: { noul: 0.94 },
          archetype: { choice: "formatting", confidence: 0.95 },
        },
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
      }),
    }),
  });
  assert.equal(resLowElig.status, "ok");
  assert.equal(resLowElig.route, "baseline", "Eligibility < 0.95 must not route to cheap");

  // Archetype confidence 0.89 (< 0.90 threshold) even with high skill confidence
  const resLowArchConf = await decide({
    task: "Format code indentation in config.json",
    skills: [{ name: "formatting", description: "Format code" }],
    apiKey: "test-key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        answers: {
          skill: { choice: "formatting", confidence: 0.99 },
          eligible: { noul: 0.98 },
          archetype: { choice: "formatting", confidence: 0.89 },
        },
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
      }),
    }),
  });
  assert.equal(resLowArchConf.status, "ok");
  assert.equal(resLowArchConf.route, "baseline", "Skill confidence cannot substitute routing confidence");
});

test("decide: timer covers response body read and caller abort listener is cleaned up in finally", async () => {
  const callerController = new AbortController();
  let listenerCount = 0;
  const trackedSignal = {
    aborted: false,
    reason: undefined,
    addEventListener(event, fn) {
      if (event === "abort") listenerCount++;
    },
    removeEventListener(event, fn) {
      if (event === "abort") listenerCount--;
    },
  };

  const res = await decide({
    task: "Lookup file path",
    skills: [{ name: "lookup", description: "Look up" }],
    apiKey: "test-key",
    signal: trackedSignal,
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        model: "typesafe/jev-1.13",
        answers: {
          skill: { choice: "lookup", confidence: 0.95 },
          eligible: { noul: 0.96 },
          archetype: { choice: "lookup", confidence: 0.92 },
        },
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
      }),
    }),
  });

  assert.equal(res.status, "ok");
  assert.equal(listenerCount, 0, "Abort listener must be removed in finally");
});

test("decide: works with real Response-like fixture", async () => {
  const payload = JSON.stringify({
    model: "typesafe/jev-1.13-20260917",
    answers: {
      skill: { choice: "lookup", confidence: 0.95 },
      eligible: { noul: 0.96 },
      archetype: { choice: "lookup", confidence: 0.92 },
    },
    usage: { input_tokens: 120, output_tokens: 25, cost: 0.00001 },
  });

  const realResponse = new Response(payload, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const res = await decide({
    task: "Look up symbol definition in module",
    skills: [{ name: "lookup", description: "Lookup symbol" }],
    apiKey: "test-key",
    fetchImpl: async () => realResponse,
  });

  assert.equal(res.status, "ok");
  assert.equal(res.skill, "lookup");
  assert.equal(res.route, "cheap");
  assert.equal(res.archetype, "lookup");
});

// ---------------------------------------------------------------------------
// 5. policyFingerprint
// ---------------------------------------------------------------------------

test("policyFingerprint: computes deterministic sha256 hex string", () => {
  const fp1 = policyFingerprint({
    catalogFingerprint: "cat123",
    candidateModel: "cand-model",
    baselineModel: "base-model",
    decisionModel: "typesafe/jev-1.13",
  });
  const fp2 = policyFingerprint({
    catalogFingerprint: "cat123",
    candidateModel: "cand-model",
    baselineModel: "base-model",
    decisionModel: "typesafe/jev-1.13",
  });
  assert.equal(fp1, fp2);
  assert.equal(typeof fp1, "string");
  assert.equal(fp1.length, 64);

  const fpDifferent = policyFingerprint({
    catalogFingerprint: "cat999",
    candidateModel: "cand-model",
    baselineModel: "base-model",
    decisionModel: "typesafe/jev-1.13",
  });
  assert.notEqual(fp1, fpDifferent);
});

// ---------------------------------------------------------------------------
// 6. evaluateReport
// ---------------------------------------------------------------------------

test("evaluateReport: passes when all skill and routing hurdles are met with raw case arrays", () => {
  const skillCases = [];
  // 12 calibration cases
  for (let i = 0; i < 12; i++) {
    skillCases.push({
      id: `calib-skill-${i}`,
      isCalibration: true,
      expectedSkills: ["skill-a"],
      baselineSkill: "skill-a",
      candidateSkill: "skill-a",
      baselineRequested: true,
      candidateRequested: true,
      candidateAttempted: true,
      baselineAttempted: true,
      baselineCostUsd: 0.001,
      candidateCostUsd: 0.0002,
    });
  }
  // 30 eligible heldout cases
  for (let i = 0; i < 30; i++) {
    skillCases.push({
      id: `heldout-skill-${i}`,
      expectedSkills: ["skill-a"],
      baselineSkill: "skill-a",
      candidateSkill: "skill-a",
      baselineRequested: true,
      candidateRequested: true,
      candidateAttempted: true,
      baselineAttempted: true,
      baselineCostUsd: 0.001,
      candidateCostUsd: 0.0002,
    });
  }
  // 10 no-skill heldout cases where candidate correctly chose none
  for (let i = 0; i < 10; i++) {
    skillCases.push({
      id: `heldout-skill-none-${i}`,
      expectedSkills: [],
      baselineSkill: null,
      candidateSkill: "none",
      baselineRequested: true,
      candidateRequested: true,
      candidateAttempted: true,
      baselineAttempted: true,
      baselineCostUsd: 0.001,
      candidateCostUsd: 0.0002,
    });
  }
  // 5 safety cases with 0 misses and no network requests
  for (let i = 0; i < 5; i++) {
    skillCases.push({
      id: `heldout-safety-${i}`,
      isSafety: true,
      baselineRequested: false,
      candidateRequested: false,
      baselineAttempted: false,
      candidateAttempted: false,
      baselineCostUsd: 0,
      candidateCostUsd: 0,
    });
  }

  const routingCases = [];
  const validArchetypes = ["lookup", "json-transform", "formatting", "text-normalization"];
  for (let i = 0; i < 8; i++) {
    routingCases.push({
      id: `heldout-route-${i}`,
      archetype: validArchetypes[i % validArchetypes.length],
      expected: `exact output result ${i}`,
      expectedType: "text",
      baselineOutput: `exact output result ${i}`,
      candidatePrimaryOutput: `exact output result ${i}`,
      baselineRequested: true,
      decisionRequested: true,
      candidateRequested: true,
      recoveryRequested: false,
      baselineAttempted: true,
      baselineAccepted: true,
      candidatePrimaryAttempted: true,
      candidatePrimaryAccepted: true,
      recoveryAccepted: false,
      baselineCostUsd: 0.001,
      candidateCostUsd: 0.0002,
    });
  }

  const catalogFingerprint = "cat123";
  const candidateModel = "cand-model";
  const baselineModel = "base-model";
  const decisionModel = "typesafe/jev-1.13";
  const fingerprint = policyFingerprint({
    catalogFingerprint,
    candidateModel,
    baselineModel,
    decisionModel,
  });

  const report = {
    version: 1,
    completed: true,
    errors: 0,
    requests: 128,
    spendUsd: 0.072,
    unknownSpendUsd: 0,
    maxCostUsd: 1.0,
    decisionSnapshots: ["typesafe/jev-1.13-20260917"],
    catalogFingerprint,
    candidateModel,
    baselineModel,
    decisionModel,
    fingerprint,
    calibration: { total: 12, hash: "a".repeat(64) },
    heldout: { total: 45, hash: "b".repeat(64) },
    datasetHashes: {
      calibration: "a".repeat(64),
      heldout: "b".repeat(64),
      outcomes: "c".repeat(64),
    },
    skills: {
      total: skillCases.length,
      eligible: 40,
      safetyTotal: 5,
      safetyMisses: 0,
      baseline: {
        attempted: 40,
        correct: 40,
        falsePositives: 0,
        costUsd: 0.04,
      },
      candidate: {
        attempted: 40,
        correct: 40,
        falsePositives: 0,
        criticalMisses: 0,
        costUsd: 0.008,
      },
      cases: skillCases,
    },
    routing: {
      total: routingCases.length,
      safetyMisses: 0,
      archetypes: ["formatting", "json-transform", "lookup", "text-normalization"],
      baseline: {
        primaryAccepted: 8,
        costUsd: 0.008,
      },
      candidate: {
        primaryAccepted: 8,
        recoveryAccepted: 0,
        costUsd: 0.0016,
      },
      cases: routingCases,
    },
  };

  const res = evaluateReport(report);
  assert.equal(res.skillPassed, true);
  assert.equal(res.routingPassed, true);
  assert.deepEqual(res.archetypes.sort(), ["formatting", "json-transform", "lookup", "text-normalization"]);
});

test("evaluateReport: rejects report when skill cases < 40 or routing cases < 8", () => {
  const calibCases = Array.from({ length: 12 }, (_, i) => ({
    id: `calib-skill-${i}`,
    isCalibration: true,
    expectedSkills: ["a"],
    candidateSkill: "a",
    baselineRequested: true,
    candidateRequested: true,
    candidateAttempted: true,
    baselineAttempted: true,
    baselineSkill: "a",
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));
  const shortHeldoutCases = Array.from({ length: 25 }, (_, i) => ({
    id: `heldout-skill-${i}`,
    expectedSkills: ["a"],
    candidateSkill: "a",
    baselineRequested: true,
    candidateRequested: true,
    candidateAttempted: true,
    baselineAttempted: true,
    baselineSkill: "a",
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));
  const skillCases = [...calibCases, ...shortHeldoutCases];

  const shortReport = {
    version: 1,
    completed: true,
    errors: 0,
    requests: 86,
    spendUsd: 0.0492,
    unknownSpendUsd: 0,
    maxCostUsd: 1.0,
    decisionSnapshots: ["typesafe/jev-1.13"],
    catalogFingerprint: "cat",
    candidateModel: "cand",
    baselineModel: "base",
    decisionModel: "typesafe/jev-1.13",
    fingerprint: policyFingerprint({
      catalogFingerprint: "cat",
      candidateModel: "cand",
      baselineModel: "base",
      decisionModel: "typesafe/jev-1.13",
    }),
    calibration: { total: 12, hash: "a".repeat(64) },
    heldout: { total: 25, hash: "b".repeat(64) },
    datasetHashes: { calibration: "a".repeat(64), heldout: "b".repeat(64), outcomes: "c".repeat(64) },
    skills: {
      total: 37,
      eligible: 25,
      safetyTotal: 0,
      safetyMisses: 0,
      cases: skillCases,
      baseline: { attempted: 25, correct: 25, costUsd: 0.025 },
      candidate: { attempted: 25, correct: 25, criticalMisses: 0, costUsd: 0.005 },
    },
    routing: {
      total: 4, // Less than 8!
      safetyMisses: 0,
      cases: Array.from({ length: 4 }, (_, i) => ({
        id: `heldout-route-${i}`,
        archetype: "lookup",
        baselineRequested: true,
        decisionRequested: true,
        candidateRequested: true,
        recoveryRequested: false,
        baselineAttempted: true,
        baselineAccepted: true,
        candidatePrimaryAttempted: true,
        candidatePrimaryAccepted: true,
        baselineCostUsd: 0.001,
        candidateCostUsd: 0.0002,
      })),
      baseline: { primaryAccepted: 4, costUsd: 0.004 },
      candidate: { primaryAccepted: 4, recoveryAccepted: 0, costUsd: 0.0008 },
    },
  };

  const res = evaluateReport(shortReport);
  assert.equal(res.skillPassed, false, "Must reject skill evaluation when cases < 40");
  assert.equal(res.routingPassed, false, "Must reject routing evaluation when cases < 8");
});

test("evaluateReport: recomputes correctness from expectedSkills sets and rejects attacker-supplied candidateCorrect", () => {
  const calibCases = Array.from({ length: 12 }, (_, i) => ({
    id: `calib-skill-${i}`,
    isCalibration: true,
    expectedSkills: ["agent-browser"],
    candidateSkill: "agent-browser",
    baselineRequested: true,
    candidateRequested: true,
    candidateAttempted: true,
    baselineAttempted: true,
    baselineSkill: "agent-browser",
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  const heldoutCases = Array.from({ length: 40 }, (_, i) => ({
    id: `heldout-skill-${i}`,
    expectedSkills: ["agent-browser", "playwright-cli"],
    candidateSkill: "wrong-skill", // Wrong skill returned!
    candidateCorrect: true, // Attacker forged flag!
    baselineRequested: true,
    candidateRequested: true,
    candidateAttempted: true,
    baselineAttempted: true,
    baselineSkill: "agent-browser",
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));
  const skillCases = [...calibCases, ...heldoutCases];

  const report = {
    version: 1,
    completed: true,
    errors: 0,
    requests: 128,
    spendUsd: 0.072,
    unknownSpendUsd: 0,
    maxCostUsd: 1.0,
    decisionSnapshots: ["typesafe/jev-1.13"],
    catalogFingerprint: "cat",
    candidateModel: "cand",
    baselineModel: "base",
    decisionModel: "typesafe/jev-1.13",
    fingerprint: policyFingerprint({
      catalogFingerprint: "cat",
      candidateModel: "cand",
      baselineModel: "base",
      decisionModel: "typesafe/jev-1.13",
    }),
    calibration: { total: 12, hash: "a".repeat(64) },
    heldout: { total: 40, hash: "b".repeat(64) },
    datasetHashes: { calibration: "a".repeat(64), heldout: "b".repeat(64), outcomes: "c".repeat(64) },
    skills: {
      total: 52,
      eligible: 40,
      safetyTotal: 0,
      safetyMisses: 0,
      baseline: { attempted: 40, correct: 40, costUsd: 0.04 },
      candidate: { attempted: 40, correct: 0, criticalMisses: 0, costUsd: 0.008 },
      cases: skillCases,
    },
    routing: {
      total: 8,
      safetyMisses: 0,
      archetypes: ["lookup"],
      baseline: { primaryAccepted: 8, costUsd: 0.008 },
      candidate: { primaryAccepted: 8, recoveryAccepted: 0, costUsd: 0.0016 },
      cases: Array.from({ length: 8 }, (_, i) => ({
        id: `heldout-route-${i}`,
        archetype: "lookup",
        baselineRequested: true,
        decisionRequested: true,
        candidateRequested: true,
        recoveryRequested: false,
        baselineAttempted: true,
        baselineAccepted: true,
        candidatePrimaryAttempted: true,
        candidatePrimaryAccepted: true,
        baselineCostUsd: 0.001,
        candidateCostUsd: 0.0002,
      })),
    },
  };

  const res = evaluateReport(report);
  assert.equal(res.skillPassed, false, "Must recompute correctness and reject when observed skill is wrong");
});

test("evaluateReport: rejects inconsistent cost sums or fabricated fallback costs", () => {
  const calibCases = Array.from({ length: 12 }, (_, i) => ({
    id: `calib-skill-${i}`,
    isCalibration: true,
    expectedSkills: ["lookup"],
    candidateSkill: "lookup",
    baselineRequested: true,
    candidateRequested: true,
    candidateAttempted: true,
    baselineAttempted: true,
    baselineSkill: "lookup",
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  const heldoutCases = Array.from({ length: 40 }, (_, i) => ({
    id: `heldout-skill-${i}`,
    expectedSkills: ["lookup"],
    candidateSkill: "lookup",
    baselineRequested: true,
    candidateRequested: true,
    candidateAttempted: true,
    baselineAttempted: true,
    baselineSkill: "lookup",
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));
  const skillCases = [...calibCases, ...heldoutCases];

  const report = {
    version: 1,
    completed: true,
    errors: 0,
    requests: 128,
    spendUsd: 0.072,
    unknownSpendUsd: 0,
    maxCostUsd: 1.0,
    decisionSnapshots: ["typesafe/jev-1.13"],
    catalogFingerprint: "cat",
    candidateModel: "cand",
    baselineModel: "base",
    decisionModel: "typesafe/jev-1.13",
    fingerprint: policyFingerprint({
      catalogFingerprint: "cat",
      candidateModel: "cand",
      baselineModel: "base",
      decisionModel: "typesafe/jev-1.13",
    }),
    calibration: { total: 12, hash: "a".repeat(64) },
    heldout: { total: 40, hash: "b".repeat(64) },
    datasetHashes: { calibration: "a".repeat(64), heldout: "b".repeat(64), outcomes: "c".repeat(64) },
    skills: {
      total: 52,
      eligible: 40,
      safetyTotal: 0,
      safetyMisses: 0,
      // Fabricated baseline costUsd mismatching the sum of cases (0.999 vs 0.04)
      baseline: { attempted: 40, correct: 40, costUsd: 0.999 },
      candidate: { attempted: 40, correct: 40, criticalMisses: 0, costUsd: 0.008 },
      cases: skillCases,
    },
    routing: {
      total: 8,
      safetyMisses: 0,
      archetypes: ["lookup"],
      baseline: { primaryAccepted: 8, costUsd: 0.008 },
      candidate: { primaryAccepted: 8, recoveryAccepted: 0, costUsd: 0.0016 },
      cases: Array.from({ length: 8 }, (_, i) => ({
        id: `heldout-route-${i}`,
        archetype: "lookup",
        baselineRequested: true,
        decisionRequested: true,
        candidateRequested: true,
        recoveryRequested: false,
        baselineAttempted: true,
        baselineAccepted: true,
        candidatePrimaryAttempted: true,
        candidatePrimaryAccepted: true,
        baselineCostUsd: 0.001,
        candidateCostUsd: 0.0002,
      })),
    },
  };

  const res = evaluateReport(report);
  assert.equal(res.skillPassed, false, "Must reject inconsistent summary costs");
});

test("evaluateReport: rejects fake passed booleans when case arrays fail hurdles", () => {
  const calibCases = Array.from({ length: 12 }, (_, i) => ({
    id: `calib-skill-${i}`,
    isCalibration: true,
    expectedSkills: ["a"],
    candidateSkill: "a",
    baselineSkill: "a",
    baselineRequested: true,
    candidateRequested: true,
    baselineAttempted: true,
    candidateAttempted: true,
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  const heldoutCases = [
    { id: "heldout-safety-0", isSafety: true, safetyMiss: true, baselineRequested: false, candidateRequested: false, baselineCostUsd: 0, candidateCostUsd: 0 },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `heldout-skill-${i}`,
      expectedSkills: ["a"],
      candidateSkill: "b",
      baselineSkill: "a",
      baselineRequested: true,
      candidateRequested: true,
      baselineAttempted: true,
      candidateAttempted: true,
      criticalMiss: true,
      baselineCostUsd: 0.001,
      candidateCostUsd: 0.002,
    })),
  ];
  const skillCases = [...calibCases, ...heldoutCases];

  const report = {
    version: 1,
    completed: true,
    errors: 0,
    requests: 54,
    spendUsd: 0.0554,
    unknownSpendUsd: 0,
    maxCostUsd: 1.0,
    decisionSnapshots: ["typesafe/jev-1.13"],
    catalogFingerprint: "cat",
    candidateModel: "cand",
    baselineModel: "base",
    decisionModel: "typesafe/jev-1.13",
    fingerprint: policyFingerprint({
      catalogFingerprint: "cat",
      candidateModel: "cand",
      baselineModel: "base",
      decisionModel: "typesafe/jev-1.13",
    }),
    calibration: { total: 12, hash: "a".repeat(64) },
    heldout: { total: 10, hash: "b".repeat(64) },
    datasetHashes: { calibration: "a".repeat(64), heldout: "b".repeat(64), outcomes: "c".repeat(64) },
    skillPassed: true,
    routingPassed: true,
    skills: {
      total: 22,
      eligible: 9,
      safetyTotal: 1,
      safetyMisses: 1,
      baseline: { attempted: 9, correct: 9, falsePositives: 0, costUsd: 0.009 },
      candidate: { attempted: 9, correct: 0, falsePositives: 0, criticalMisses: 9, costUsd: 0.018 },
      cases: skillCases,
    },
    routing: {
      total: 4,
      safetyMisses: 1,
      archetypes: ["lookup"],
      baseline: { primaryAccepted: 4, costUsd: 0.004 },
      candidate: { primaryAccepted: 2, recoveryAccepted: 2, costUsd: 0.01 },
      cases: [
        { id: "route-0", archetype: "lookup", baselineRequested: true, decisionRequested: true, candidateRequested: true, recoveryRequested: false, baselineAttempted: true, baselineAccepted: true, candidatePrimaryAttempted: true, candidatePrimaryAccepted: true, safetyMiss: true, baselineCostUsd: 0.001, candidateCostUsd: 0.0025 },
        { id: "route-1", archetype: "lookup", baselineRequested: true, decisionRequested: true, candidateRequested: true, recoveryRequested: false, baselineAttempted: true, baselineAccepted: true, candidatePrimaryAttempted: true, candidatePrimaryAccepted: true, baselineCostUsd: 0.001, candidateCostUsd: 0.0025 },
        { id: "route-2", archetype: "lookup", baselineRequested: true, decisionRequested: true, candidateRequested: false, recoveryRequested: true, baselineAttempted: true, baselineAccepted: true, candidatePrimaryAttempted: false, candidatePrimaryAccepted: false, recoveryAccepted: true, baselineCostUsd: 0.001, candidateCostUsd: 0.0025 },
        { id: "route-3", archetype: "lookup", baselineRequested: true, decisionRequested: true, candidateRequested: false, recoveryRequested: true, baselineAttempted: true, baselineAccepted: true, candidatePrimaryAttempted: false, candidatePrimaryAccepted: false, recoveryAccepted: true, baselineCostUsd: 0.001, candidateCostUsd: 0.0025 },
      ],
    },
  };

  const res = evaluateReport(report);
  assert.equal(res.skillPassed, false, "Must reject skill when critical/safety misses exist or precision < 95%");
  assert.equal(res.routingPassed, false, "Must reject routing when cases < 8 or safety misses > 0 or candidate cost higher");
  assert.deepEqual(res.archetypes, []);
});

test("evaluateReport: rejects incomplete reports or reports with errors, dryRun, or simulated", () => {
  const incompleteReport = {
    version: 1,
    completed: false,
    errors: 2,
    skills: { cases: [] },
    routing: { cases: [] },
  };
  const res = evaluateReport(incompleteReport);
  assert.equal(res.skillPassed, false);
  assert.equal(res.routingPassed, false);

  assert.equal(evaluateReport({ ...incompleteReport, completed: true, errors: 0, dryRun: true }).skillPassed, false);
  assert.equal(evaluateReport({ ...incompleteReport, completed: true, errors: 0, simulated: true }).skillPassed, false);
});

// ---------------------------------------------------------------------------
// 7. readPolicy
// ---------------------------------------------------------------------------

test("readPolicy: returns validated policy with decisionSnapshots when report sha256, fingerprint and hurdles match", () => {
  const tmp = createTempDir("policy-valid-");
  try {
    const home = join(tmp, "home");
    const cwd = join(tmp, "proj");
    const agentDir = join(home, ".omp", "agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const calibCases = Array.from({ length: 12 }, (_, i) => ({
      id: `calib-skill-${i}`,
      isCalibration: true,
      expectedSkills: ["lookup"],
      candidateSkill: "lookup",
      baselineRequested: true,
      candidateRequested: true,
      candidateAttempted: true,
      baselineAttempted: true,
      baselineSkill: "lookup",
      baselineCostUsd: 0.001,
      candidateCostUsd: 0.0002,
    }));
    const heldoutCases = Array.from({ length: 40 }, (_, i) => ({
      id: `heldout-skill-${i}`,
      expectedSkills: ["lookup"],
      candidateSkill: "lookup",
      baselineRequested: true,
      candidateRequested: true,
      candidateAttempted: true,
      baselineAttempted: true,
      baselineSkill: "lookup",
      baselineCostUsd: 0.001,
      candidateCostUsd: 0.0002,
    }));
    const skillCases = [...calibCases, ...heldoutCases];
    const routingCases = Array.from({ length: 8 }, (_, i) => ({
      id: `heldout-route-${i}`,
      archetype: "lookup",
      expected: `res-${i}`,
      expectedType: "text",
      baselineOutput: `res-${i}`,
      candidatePrimaryOutput: `res-${i}`,
      baselineRequested: true,
      decisionRequested: true,
      candidateRequested: true,
      recoveryRequested: false,
      baselineAttempted: true,
      baselineAccepted: true,
      candidatePrimaryAttempted: true,
      candidatePrimaryAccepted: true,
      recoveryAccepted: false,
      baselineCostUsd: 0.001,
      candidateCostUsd: 0.0002,
    }));

    const catalogFingerprint = "cat123";
    const candidateModel = "cand-model";
    const baselineModel = "base-model";
    const decisionModel = "typesafe/jev-1.13";
    const fp = policyFingerprint({
      catalogFingerprint,
      candidateModel,
      baselineModel,
      decisionModel,
    });

    const reportObj = {
      version: 1,
      completed: true,
      errors: 0,
      requests: 128,
      spendUsd: 0.072,
      unknownSpendUsd: 0,
      maxCostUsd: 1.0,
      decisionSnapshots: ["typesafe/jev-1.13-20260917"],
      catalogFingerprint,
      candidateModel,
      baselineModel,
      decisionModel,
      fingerprint: fp,
      calibration: { total: 12, hash: "a".repeat(64) },
      heldout: { total: 40, hash: "b".repeat(64) },
      modelPrices: { "cand-model": { inputRate: 0.042 } },
      datasetHashes: {
        calibration: "a".repeat(64),
        heldout: "b".repeat(64),
        outcomes: "c".repeat(64),
      },
      skills: {
        total: 52,
        eligible: 40,
        safetyTotal: 0,
        safetyMisses: 0,
        baseline: { attempted: 40, correct: 40, falsePositives: 0, costUsd: 0.04 },
        candidate: { attempted: 40, correct: 40, falsePositives: 0, criticalMisses: 0, costUsd: 0.008 },
        cases: skillCases,
      },
      routing: {
        total: 8,
        safetyMisses: 0,
        archetypes: ["lookup"],
        baseline: { primaryAccepted: 8, costUsd: 0.008 },
        candidate: { primaryAccepted: 8, recoveryAccepted: 0, costUsd: 0.0016 },
        cases: routingCases,
      },
    };

    const reportJson = JSON.stringify(reportObj, null, 2);
    const reportSha256 = createHash("sha256").update(reportJson, "utf8").digest("hex");
    writeFileSync(join(agentDir, "jev-evaluation.json"), reportJson, "utf8");

    const policyObj = {
      version: 1,
      enabled: true,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      catalogFingerprint,
      candidateModel,
      baselineModel,
      decisionModel,
      fingerprint: fp,
      skillPassed: true,
      routingPassed: true,
      reportSha256,
      archetypes: ["lookup"],
    };
    writeFileSync(join(agentDir, "jev-policy.json"), JSON.stringify(policyObj, null, 2), "utf8");

    const policy = readPolicy({ home, cwd, fingerprint: policyObj.fingerprint });
    assert.ok(policy !== null);
    assert.equal(policy.enabled, true);
    assert.equal(policy.skillPassed, true);
    assert.equal(policy.routingPassed, true);
    assert.deepEqual(policy.archetypes, ["lookup"]);
    assert.deepEqual(policy.decisionSnapshots, ["typesafe/jev-1.13-20260917"]);
    assert.deepEqual(policy.modelPrices, { "cand-model": { inputRate: 0.042 } });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readPolicy: returns null on sha256 mismatch, expired policy, or opt-out", () => {
  const tmp = createTempDir("policy-invalid-");
  try {
    const home = join(tmp, "home");
    const cwd = join(tmp, "proj");
    const agentDir = join(home, ".omp", "agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    // 1. Report tampered (sha mismatch)
    writeFileSync(join(agentDir, "jev-evaluation.json"), JSON.stringify({ version: 1 }), "utf8");
    writeFileSync(
      join(agentDir, "jev-policy.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        catalogFingerprint: "cat",
        candidateModel: "cand",
        baselineModel: "base",
        decisionModel: "typesafe/jev-1.13",
        fingerprint: "fake",
        reportSha256: "0000000000000000000000000000000000000000000000000000000000000000",
      }),
      "utf8"
    );

    assert.equal(readPolicy({ home, cwd }), null, "Must reject on reportSha256 mismatch");

    // 2. Expired policy
    writeFileSync(
      join(agentDir, "jev-policy.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
      "utf8"
    );
    assert.equal(readPolicy({ home, cwd }), null, "Must reject expired policy");

    // 3. Project opt-out file
    writeFileSync(join(cwd, ".jev-optout"), "", "utf8");
    assert.equal(readPolicy({ home, cwd }), null, "Must honor opt-out");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. appendEvent
// ---------------------------------------------------------------------------

test("appendEvent: writes allow-listed aggregate fields and redacts raw prompts/keys from all string fields", () => {
  const tmp = createTempDir("event-test-");
  try {
    appendEvent(tmp, {
      event: "decision",
      ts: "2026-09-30T12:00:00.000Z",
      route: "cheap",
      skill: "lookup",
      archetype: "lookup",
      confidence: 0.95,
      status: "ok",
      reason: "failed on sample-person@private-example.invalid with key sk-or-v1-abcdef012345",
      inputTokens: 350,
      outputTokens: 45,
      costUsd: 0.000015,
      model: "typesafe/jev-1.13-sk-or-v1-abcdef012345",
      durationMs: 450,
      sessionId: "sess-123",
      prompt: "Canary prompt containing secret sk-or-v1-abcdef012345",
      apiKey: "sk-or-v1-abcdef012345",
      rawResponse: { error: "internal error" },
    });

    const logPath = join(tmp, ".workflow", "jev-events.jsonl");
    assert.ok(existsSync(logPath));
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);

    const record = JSON.parse(lines[0]);
    assert.equal(record.event, "decision");
    assert.equal(record.route, "cheap");
    assert.equal(record.skill, "lookup");
    assert.equal(record.confidence, 0.95);
    assert.equal(record.inputTokens, 350);

    // Verify redactions
    assert.equal(record.prompt, undefined);
    assert.equal(record.apiKey, undefined);
    assert.equal(record.rawResponse, undefined);
    assert.ok(!JSON.stringify(record).includes("sk-or-v1-abcdef012345"));
    assert.ok(!JSON.stringify(record).includes("sample-person@private-example.invalid"));
    assert.ok(record.reason.includes("[REDACTED]"));
    assert.ok(record.model.includes("[REDACTED]"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. Boundary Regressions
// ---------------------------------------------------------------------------

function makeValidReportFixture() {
  const calibCases = Array.from({ length: 12 }, (_, i) => ({
    id: `calib-skill-${i}`,
    isCalibration: true,
    expectedSkills: ["lookup"],
    candidateSkill: "lookup",
    baselineRequested: true,
    candidateRequested: true,
    candidateAttempted: true,
    baselineAttempted: true,
    baselineSkill: "lookup",
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  const heldoutCases = Array.from({ length: 40 }, (_, i) => ({
    id: `heldout-skill-${i}`,
    expectedSkills: ["lookup"],
    candidateSkill: "lookup",
    baselineRequested: true,
    candidateRequested: true,
    candidateAttempted: true,
    baselineAttempted: true,
    baselineSkill: "lookup",
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  const skillCases = [...calibCases, ...heldoutCases];

  const routingCases = Array.from({ length: 8 }, (_, i) => ({
    id: `heldout-route-${i}`,
    archetype: "lookup",
    expected: "full complete text output",
    expectedType: "text",
    baselineOutput: "full complete text output",
    candidatePrimaryOutput: "full complete text output",
    baselineRequested: true,
    decisionRequested: true,
    candidateRequested: true,
    recoveryRequested: false,
    baselineAttempted: true,
    baselineAccepted: true,
    candidatePrimaryAttempted: true,
    candidatePrimaryAccepted: true,
    recoveryAccepted: false,
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  return {
    version: 1,
    completed: true,
    errors: 0,
    requests: 128,
    spendUsd: 0.072,
    unknownSpendUsd: 0,
    maxCostUsd: 1.0,
    decisionSnapshots: ["typesafe/jev-1.13"],
    catalogFingerprint: "cat",
    candidateModel: "cand",
    baselineModel: "base",
    decisionModel: "typesafe/jev-1.13",
    fingerprint: policyFingerprint({
      catalogFingerprint: "cat",
      candidateModel: "cand",
      baselineModel: "base",
      decisionModel: "typesafe/jev-1.13",
    }),
    calibration: { total: 12, hash: "a".repeat(64) },
    heldout: { total: 40, hash: "b".repeat(64) },
    datasetHashes: { calibration: "a".repeat(64), heldout: "b".repeat(64), outcomes: "c".repeat(64) },
    skills: {
      total: 52,
      eligible: 40,
      safetyTotal: 0,
      safetyMisses: 0,
      baseline: { attempted: 40, correct: 40, costUsd: 0.04 },
      candidate: { attempted: 40, correct: 40, criticalMisses: 0, costUsd: 0.008 },
      cases: skillCases,
    },
    routing: {
      total: 8,
      safetyMisses: 0,
      archetypes: ["lookup"],
      baseline: { primaryAccepted: 8, costUsd: 0.008 },
      candidate: { primaryAccepted: 8, recoveryAccepted: 0, costUsd: 0.0016 },
      cases: routingCases,
    },
  };
}

test("evaluateReport boundary: partial output must not pass exact outcome matching", () => {
  const report = makeValidReportFixture();
  report.routing.cases[0].candidatePrimaryOutput = "full complete";
  const res = evaluateReport(report);
  assert.equal(res.routingPassed, false, "Partial prefix output must fail exact match");
});

test("evaluateReport boundary: calibration cases cannot qualify held-out quota", () => {
  const report = makeValidReportFixture();
  // Turn 10 heldout cases into calibration cases so heldout count drops to 30 (< 40)
  for (let i = 12; i < 22; i++) {
    report.skills.cases[i].id = `calib-extra-${i}`;
    report.skills.cases[i].isCalibration = true;
  }
  report.calibration = { total: 22, hash: "a".repeat(64) };
  report.heldout = { total: 30, hash: "b".repeat(64) };
  report.skills.eligible = 30;
  report.skills.baseline = { attempted: 30, correct: 30, costUsd: 0.03 };
  report.skills.candidate = { attempted: 30, correct: 30, criticalMisses: 0, costUsd: 0.006 };

  const res = evaluateReport(report);
  assert.equal(res.skillPassed, false, "Calibration cases cannot satisfy >=40 heldout requirement");
});

test("evaluateReport boundary: calibration successes cannot inflate held-out precision or coverage", () => {
  const report = makeValidReportFixture();
  // 40 heldout cases with 3 wrong predictions (37/40 = 92.5% precision < 95% threshold)
  for (let i = 12; i < 15; i++) {
    report.skills.cases[i].candidateSkill = "wrong-skill";
  }
  // Add 20 calibration successes so global precision would be 57/60 = 95% if mixed
  for (let i = 0; i < 20; i++) {
    report.skills.cases.push({
      id: `calib-extra-${i}`,
      isCalibration: true,
      expectedSkills: ["lookup"],
      candidateSkill: "lookup",
      baselineRequested: true,
      candidateRequested: true,
      candidateAttempted: true,
      baselineAttempted: true,
      baselineSkill: "lookup",
      baselineCostUsd: 0.001,
      candidateCostUsd: 0.0002,
    });
  }
  report.calibration = { total: 32, hash: "a".repeat(64) };
  report.heldout = { total: 40, hash: "b".repeat(64) };
  report.skills.total = 72;
  report.skills.eligible = 40;
  report.skills.baseline = { attempted: 40, correct: 40, costUsd: 0.04 };
  report.skills.candidate = { attempted: 40, correct: 37, criticalMisses: 0, costUsd: 0.008 };
  report.requests = 168;
  report.spendUsd = 0.096;

  const res = evaluateReport(report);
  assert.equal(res.skillPassed, false, "Calibration successes must not inflate held-out precision above 95%");
});

test("evaluateReport boundary: rejects bogus global spendUsd or negative errors", () => {
  const reportBogusSpend = makeValidReportFixture();
  reportBogusSpend.spendUsd = 0.0096; // Bogus spend mismatching actual sum 0.072
  assert.equal(evaluateReport(reportBogusSpend).skillPassed, false, "Must reject bogus spendUsd");

  const reportNegErrors = makeValidReportFixture();
  reportNegErrors.errors = -1;
  assert.equal(evaluateReport(reportNegErrors).skillPassed, false, "Must reject negative errors");
});

test("evaluateReport boundary: rejects mismatched request count or network flags on safety rows", () => {
  const reportBadReqs = makeValidReportFixture();
  reportBadReqs.requests = 96; // Mismatches actual 128 outbound requests
  assert.equal(evaluateReport(reportBadReqs).skillPassed, false, "Must reject mismatched request count");

  const reportSafetyNet = makeValidReportFixture();
  reportSafetyNet.skills.cases.push({
    id: "heldout-safety-leak",
    isSafety: true,
    baselineRequested: true, // Safety row must not make outbound network request
    candidateRequested: false,
    baselineCostUsd: 0,
    candidateCostUsd: 0,
  });
  reportSafetyNet.skills.total = 53;
  reportSafetyNet.skills.safetyTotal = 1;
  reportSafetyNet.heldout.total = 41;
  reportSafetyNet.requests = 129;
  assert.equal(evaluateReport(reportSafetyNet).skillPassed, false, "Must reject network requests on safety rows");
});

test("evaluateReport boundary: rejects missing or false primary-attempt claims even if fabricated accepted true", () => {
  const report = makeValidReportFixture();
  report.routing.cases[0].candidatePrimaryAttempted = false;
  const res = evaluateReport(report);
  assert.equal(res.routingPassed, false, "Must reject report claiming primary accepted without primary attempted");
});

test("evaluateReport boundary: rejects dryRun===true or simulated===true as non-proof", () => {
  const reportDry = makeValidReportFixture();
  reportDry.dryRun = true;
  assert.equal(evaluateReport(reportDry).skillPassed, false, "Must reject dryRun===true");

  const reportSim = makeValidReportFixture();
  reportSim.simulated = true;
  assert.equal(evaluateReport(reportSim).skillPassed, false, "Must reject simulated===true");
});

test("evaluateReport boundary: rejects calib cases < 12 or overlapping case IDs", () => {
  const reportFewCalib = makeValidReportFixture();
  // Remove 2 calib cases so count is 10 (< 12)
  reportFewCalib.skills.cases = reportFewCalib.skills.cases.filter((c) => c.id !== "calib-skill-10" && c.id !== "calib-skill-11");
  reportFewCalib.skills.total = 50;
  reportFewCalib.calibration = { total: 10, hash: "a".repeat(64) };
  reportFewCalib.requests = 124;
  reportFewCalib.spendUsd = 0.0696;
  assert.equal(evaluateReport(reportFewCalib).skillPassed, false, "Must reject calib cases < 12");

  const reportOverlap = makeValidReportFixture();
  // Overlap an ID between calib and heldout
  reportOverlap.skills.cases[0].id = reportOverlap.skills.cases[12].id;
  assert.equal(evaluateReport(reportOverlap).skillPassed, false, "Must reject overlapping case IDs");
});

test("loadSkillCatalog boundary: effective namespace skills preserved, disabled and raw secrets filtered", () => {
  const tmp = createTempDir("cat-effective-");
  try {
    writeFileSync(
      join(tmp, ".skills-disabled.json"),
      JSON.stringify({ disabled: ["custom-team/disabled-skill"] }),
      "utf8"
    );

    const effective = [
      { name: "skill:custom-team/active-linter", description: "Lints team code" },
      { name: "custom-team/disabled-skill", description: "Should be filtered by disabled list" },
      { name: "scoped/secret-leaker", description: "Has key sk-or-v1-0123456789abcdef01234567" },
      { name: "native:general-helper", description: "Valid namespaced native skill" },
    ];

    const catalog = loadSkillCatalog({ cwd: tmp, home: tmp, effectiveSkills: effective });
    const names = catalog.skills.map((s) => s.name);

    assert.ok(names.includes("custom-team/active-linter"), "Namespaces like foo/bar must be preserved");
    assert.ok(names.includes("native:general-helper"), "Namespaces like native:bar must be preserved");
    assert.ok(!names.includes("custom-team/disabled-skill"), "Disabled namespaced skill must be excluded");
    assert.ok(!names.includes("scoped/secret-leaker"), "Secret-leaking skill must be excluded");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("decide boundary: unknown usage and missing cost sets costKnown false, preserved on malformed answers", async () => {
  // 1. Timeout: usage costKnown is false
  const resTimeout = await decide({
    task: "Lookup file",
    apiKey: "test-key",
    timeoutMs: 1,
    fetchImpl: () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10)),
  });
  assert.equal(resTimeout.status, "fallback");
  assert.equal(resTimeout.usage.costKnown, false);

  // 2. HTTP error: usage costKnown is false
  const resHttp = await decide({
    task: "Lookup file",
    apiKey: "test-key",
    fetchImpl: async () => ({ status: 503, ok: false }),
  });
  assert.equal(resHttp.status, "fallback");
  assert.equal(resHttp.usage.costKnown, false);

  // 3. Missing / invalid cost in usage: costKnown is false
  const resNoCost = await decide({
    task: "Lookup file",
    apiKey: "test-key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        usage: { input_tokens: 100, output_tokens: 20 },
        answers: {},
      }),
    }),
  });
  assert.equal(resNoCost.status, "fallback");
  assert.equal(resNoCost.usage.costKnown, false);

  // 4. Valid usage receipt with known cost, but malformed answers: costKnown is preserved as true
  const resMalformedAnswers = await decide({
    task: "Lookup file",
    apiKey: "test-key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.000015 },
        answers: { skill: { choice: "invalid" } },
      }),
    }),
  });
  assert.equal(resMalformedAnswers.status, "fallback");
  assert.equal(resMalformedAnswers.reason, "invalid-response");
  assert.equal(resMalformedAnswers.usage.costKnown, true);
  assert.equal(resMalformedAnswers.usage.costUsd, 0.000015);

  // 5. Successful decision: eligibleScore, skillConfidence, routingConfidence, and costKnown: true
  const resSuccess = await decide({
    task: "Format config.json",
    skills: [{ name: "formatting", description: "Format" }],
    apiKey: "test-key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        usage: { input_tokens: 120, output_tokens: 30, cost: 0.00002 },
        answers: {
          skill: { choice: "formatting", confidence: 0.98 },
          eligible: { noul: 0.97 },
          archetype: { choice: "formatting", confidence: 0.95 },
        },
      }),
    }),
  });
  assert.equal(resSuccess.status, "ok");
  assert.equal(resSuccess.eligibleScore, 0.97);
  assert.equal(resSuccess.skillConfidence, 0.98);
  assert.equal(resSuccess.routingConfidence, 0.95);
  assert.equal(resSuccess.eligibility, undefined, "Must not expose eligibility alias");
  assert.equal(resSuccess.usage.costKnown, true);
});
