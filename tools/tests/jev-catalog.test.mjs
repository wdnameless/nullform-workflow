import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  readCredential,
  loadSkillCatalog,
  screenTask,
  appendEvent,
} from "../jev-assist.mjs";
import { createTempDir } from "./jev-test-helpers.mjs";

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
      `---\nname: skill-disabled\ndescription: "Disabled skill"\n---\nBody\n`,
      "utf8"
    );
    mkdirSync(join(projectDir, ".agents"), { recursive: true });
    writeFileSync(
      join(projectDir, ".agents", ".skills-disabled.json"),
      JSON.stringify({ disabled: ["skill-disabled"] }),
      "utf8"
    );

    mkdirSync(join(homeSkills, "skill-user"), { recursive: true });
    writeFileSync(
      join(homeSkills, "skill-user", "SKILL.md"),
      `---\nname: skill-user\ndescription: >\n  Multi line user\n  skill description\n---\nUser body\n`,
      "utf8"
    );

    const catalog = loadSkillCatalog({
      cwd: projectDir,
      home: userHome,
      roots: [projSkills, homeSkills],
    });

    assert.equal(catalog.skills.length, 2);
    const names = catalog.skills.map((s) => s.name);
    assert.ok(names.includes("skill-alpha"));
    assert.ok(names.includes("skill-user"));
    assert.ok(!names.includes("skill-disabled"));

    const alpha = catalog.skills.find((s) => s.name === "skill-alpha");
    assert.equal(alpha.description, "Alpha skill description");
    assert.ok(!alpha.description.includes("Do not leak body"));

    const user = catalog.skills.find((s) => s.name === "skill-user");
    assert.equal(user.description, "Multi line user skill description");
    assert.ok(catalog.fingerprint.length === 64);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadSkillCatalog: duplicate skill in earlier root takes precedence and fingerprint changes on metadata", () => {
  const tmp = createTempDir("skills-prec-");
  try {
    const rootA = join(tmp, "rootA");
    const rootB = join(tmp, "rootB");
    mkdirSync(join(rootA, "shared-skill"), { recursive: true });
    mkdirSync(join(rootB, "shared-skill"), { recursive: true });

    writeFileSync(
      join(rootA, "shared-skill", "SKILL.md"),
      `---\nname: shared-skill\ndescription: "RootA version"\n---\n`,
      "utf8"
    );
    writeFileSync(
      join(rootB, "shared-skill", "SKILL.md"),
      `---\nname: shared-skill\ndescription: "RootB version"\n---\n`,
      "utf8"
    );

    const catAFirst = loadSkillCatalog({ cwd: tmp, home: tmp, roots: [rootA, rootB] });
    assert.equal(catAFirst.skills.length, 1);
    assert.equal(catAFirst.skills[0].description, "RootA version");

    const catBFirst = loadSkillCatalog({ cwd: tmp, home: tmp, roots: [rootB, rootA] });
    assert.equal(catBFirst.skills.length, 1);
    assert.equal(catBFirst.skills[0].description, "RootB version");

    assert.notEqual(catAFirst.fingerprint, catBFirst.fingerprint);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadSkillCatalog: allows semantic security descriptions but drops skills with raw secret tokens", () => {
  const tmp = createTempDir("skills-sec-");
  try {
    const root = join(tmp, "skills");
    mkdirSync(join(root, "legit-sec"), { recursive: true });
    writeFileSync(
      join(root, "legit-sec", "SKILL.md"),
      `---\nname: legit-sec\ndescription: "Security reviewer and vulnerability auditor"\n---\n`,
      "utf8"
    );

    mkdirSync(join(root, "bad-sec"), { recursive: true });
    writeFileSync(
      join(root, "bad-sec", "SKILL.md"),
      `---\nname: bad-sec\ndescription: "Skill with leaked token sk-or-v1-abcdef0123456789012345"\n---\n`,
      "utf8"
    );

    const cat = loadSkillCatalog({ cwd: tmp, home: tmp, roots: [root] });
    const names = cat.skills.map((s) => s.name);
    assert.ok(names.includes("legit-sec"), "legitimate security skill must be kept");
    assert.ok(!names.includes("bad-sec"), "skill with actual raw token must be filtered out");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

test("screenTask: detects short claim JWTs and generic explicit credential assignments while allowing semantic discussion", () => {
  // Short claim JWT (e.g. empty/small payload e30)
  assert.equal(screenTask("Use token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ae9MIDmPCD directly").allowed, false);
  // Generic credential variable assignments (AWS, opaque references, quoted with spaces)
  assert.equal(screenTask("AWS_SECRET_ACCESS_KEY=$$AWS_SECRET_1KLE01V8T588:L$$").allowed, false);
  assert.equal(screenTask('Config: password="prod secret with spaces"').allowed, false);
  assert.equal(screenTask("Параметр: пароль='сложный секрет'").allowed, false);
  // Semantic discussion without assignment/token must remain allowed
  const discussion = screenTask("We need to document AWS_SECRET_ACCESS_KEY rotation in our security runbook.");
  assert.equal(discussion.allowed, true);
  assert.equal(discussion.reason, "ok");
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
  const codeDump = "```javascript\n" + lines.join("\n") + "\n```";
  assert.equal(screenTask(codeDump).allowed, false);

  const gitDiff = "diff --git a/file.js b/file.js\nindex 83a0..21b4 100644\n--- a/file.js\n+++ b/file.js\n";
  assert.equal(screenTask(gitDiff).allowed, false);

  const stackTrace = "Error: boom\n  at foo (app.js:10:5)\n  at bar (app.js:20:10)\n  at baz (app.js:30:15)";
  assert.equal(screenTask(stackTrace).allowed, false);

  const base64Dump = "Here is data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  assert.equal(screenTask(base64Dump).allowed, false);
});

test("screenTask: detects continuation-only and context-dependent tasks", () => {
  assert.equal(screenTask("continue").allowed, false);
  assert.equal(screenTask("продолжай").allowed, false);
  assert.equal(screenTask("same as above").allowed, false);
  assert.equal(screenTask("fix that").allowed, false);
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

  const safe2 = screenTask("Look up definition of loadSkillCatalog in tools/jev-assist.mjs");
  assert.equal(safe2.allowed, true);
  assert.equal(safe2.reason, "ok");

  const safe3 = screenTask("Audit code for OWASP top 10 security vulnerabilities");
  assert.equal(safe3.allowed, true);
  assert.equal(safe3.reason, "ok");
});

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
