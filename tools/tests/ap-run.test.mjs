import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdStart, load } from "../workflow.mjs";
import { redactSecrets, freezeBrief, oracleInput } from "../brief.mjs";
import { parseRequirement, recount, ALLOWED_TYPES, ALLOWED_STATUSES } from "../requirements.mjs";

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ap-run-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Dial validation accept/reject and state persistence
// ---------------------------------------------------------------------------

test("start: accepts default mode (semi) and depth (normal)", () => {
  withTmpDir((tmp) => {
    const code = cmdStart(tmp, { tier: "T0", task: "default-dials" });
    assert.equal(code, 0);

    const st = load(tmp);
    assert.ok(st);
    assert.equal(st.mode, "semi");
    assert.equal(st.depth, "normal");

    // Check raw state.json on disk
    const raw = JSON.parse(readFileSync(join(tmp, ".workflow", "state.json"), "utf8"));
    assert.equal(raw.mode, "semi");
    assert.equal(raw.depth, "normal");
  });
});

test("start: accepts explicit valid mode and depth dials", () => {
  withTmpDir((tmp) => {
    const code = cmdStart(tmp, { tier: "T0", task: "custom-dials", mode: "full", depth: "strict" });
    assert.equal(code, 0);

    const st = load(tmp);
    assert.equal(st.mode, "full");
    assert.equal(st.depth, "strict");

    const raw = JSON.parse(readFileSync(join(tmp, ".workflow", "state.json"), "utf8"));
    assert.equal(raw.mode, "full");
    assert.equal(raw.depth, "strict");
  });

  withTmpDir((tmp) => {
    const code = cmdStart(tmp, { tier: "T0", task: "custom-dials-2", mode: "interview", depth: "deep" });
    assert.equal(code, 0);
    const st = load(tmp);
    assert.equal(st.mode, "interview");
    assert.equal(st.depth, "deep");
  });

  withTmpDir((tmp) => {
    const code = cmdStart(tmp, { tier: "T0", task: "custom-dials-3", mode: "manual", depth: "normal" });
    assert.equal(code, 0);
    const st = load(tmp);
    assert.equal(st.mode, "manual");
    assert.equal(st.depth, "normal");
  });
});

test("start: rejects invalid mode naming the allowed set", () => {
  withTmpDir((tmp) => {
    const errMsgs = [];
    const origError = console.error;
    console.error = (msg) => errMsgs.push(msg);
    try {
      const code = cmdStart(tmp, { tier: "T0", task: "bad-mode", mode: "turbo" });
      assert.equal(code, 2);
      assert.ok(errMsgs.some((m) => m.includes("full, semi, interview, manual")));
      assert.ok(errMsgs.some((m) => m.includes("turbo")));
    } finally {
      console.error = origError;
    }
  });
});

test("start: rejects invalid depth naming the allowed set", () => {
  withTmpDir((tmp) => {
    const errMsgs = [];
    const origError = console.error;
    console.error = (msg) => errMsgs.push(msg);
    try {
      const code = cmdStart(tmp, { tier: "T0", task: "bad-depth", depth: "shallow" });
      assert.equal(code, 2);
      assert.ok(errMsgs.some((m) => m.includes("strict, normal, deep")));
      assert.ok(errMsgs.some((m) => m.includes("shallow")));
    } finally {
      console.error = origError;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Secret redaction of each secret shape
// ---------------------------------------------------------------------------

test("redactSecrets: masks sk- API key", () => {
  const secret = "sk-1234567890abcdef123456";
  const text = `Connect using API key: ${secret} to continue.`;
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(secret));
  assert.ok(redacted.includes("[REDACTED:SK_KEY]"));
  assert.equal(redacted, "Connect using API key: [REDACTED:SK_KEY] to continue.");
});

test("redactSecrets: masks ghp_ GitHub token", () => {
  const secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
  const text = `Authorization: token ${secret}`;
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(secret));
  assert.ok(redacted.includes("[REDACTED:GITHUB_TOKEN]"));
  assert.equal(redacted, "Authorization: token [REDACTED:GITHUB_TOKEN]");
});

test("redactSecrets: masks xox[abp]- Slack token", () => {
  const secretB = "xoxb-1234567890-abcdef123456";
  const secretA = "xoxa-9876543210-abcdef123456";
  const secretP = "xoxp-1122334455-abcdef123456";
  const text = `Slack bot: ${secretB}, app: ${secretA}, user: ${secretP}`;
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(secretB));
  assert.ok(!redacted.includes(secretA));
  assert.ok(!redacted.includes(secretP));
  assert.equal(redacted, "Slack bot: [REDACTED:SLACK_TOKEN], app: [REDACTED:SLACK_TOKEN], user: [REDACTED:SLACK_TOKEN]");
});

test("redactSecrets: masks AKIA AWS access key ID", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const text = `AWS_ACCESS_KEY_ID=${secret}`;
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(secret));
  assert.ok(redacted.includes("[REDACTED:AWS_KEY]"));
  assert.equal(redacted, "AWS_ACCESS_KEY_ID=[REDACTED:AWS_KEY]");
});

test("redactSecrets: masks JWT token", () => {
  const secret = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const text = `Bearer ${secret}`;
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(secret));
  assert.ok(redacted.includes("[REDACTED:JWT]"));
  assert.equal(redacted, "Bearer [REDACTED:JWT]");
});

test("redactSecrets: masks Telegram bot token", () => {
  const secret = "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345678";
  const text = `Telegram bot token: ${secret} is active`;
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(secret));
  assert.ok(redacted.includes("[REDACTED:TELEGRAM_TOKEN]"));
  assert.equal(redacted, "Telegram bot token: [REDACTED:TELEGRAM_TOKEN] is active");
});

test("redactSecrets: masks database connection strings", () => {
  const secretPg = "postgres://user:supersecretpass@localhost:5432/mydb";
  const secretMongo = "mongodb+srv://admin:pass123@cluster0.mongodb.net/prod";
  const text = `Postgres URI: ${secretPg} and Mongo: ${secretMongo}`;
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(secretPg));
  assert.ok(!redacted.includes(secretMongo));
  assert.ok(!redacted.includes("supersecretpass"));
  assert.ok(!redacted.includes("pass123"));
  assert.equal(redacted, "Postgres URI: [REDACTED:CONNECTION_STRING] and Mongo: [REDACTED:CONNECTION_STRING]");
});

// ---------------------------------------------------------------------------
// 3. Freeze brief & refusal of overwrite
// ---------------------------------------------------------------------------

test("freezeBrief: writes dated file with redactions applied before disk write", () => {
  withTmpDir((dir) => {
    const secret = "sk-ant-api03-verysecretkey12345678";
    const input = `# Project brief\nUse key ${secret} to deploy.`;

    const writtenPath = freezeBrief(dir, input);
    assert.ok(existsSync(writtenPath));
    assert.match(writtenPath, /\d{4}-\d{2}-\d{2}-brief\.md$/);

    const onDisk = readFileSync(writtenPath, "utf8");
    assert.ok(!onDisk.includes(secret), "Secret must never be written to disk");
    assert.ok(onDisk.includes("[REDACTED:SK_KEY]"));
  });
});

test("freezeBrief: refuses overwrite when brief already exists", () => {
  withTmpDir((dir) => {
    freezeBrief(dir, "First brief version");
    assert.throws(
      () => freezeBrief(dir, "Second brief attempt"),
      /Refusing overwrite/
    );
  });
});

// ---------------------------------------------------------------------------
// 4. oracleInput resolves to frozen brief
// ---------------------------------------------------------------------------

test("oracleInput: resolves to frozen brief path", () => {
  withTmpDir((dir) => {
    const briefPath = freezeBrief(dir, "Valid project brief");
    const resolved = oracleInput(dir);
    assert.equal(resolved, briefPath);
  });
});

test("oracleInput: throws when brief is missing", () => {
  withTmpDir((dir) => {
    assert.throws(() => oracleInput(dir), /missing/i);
  });
});

test("oracleInput: throws when ambiguous (multiple briefs)", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "2026-10-01-brief.md"), "Brief 1", "utf8");
    writeFileSync(join(dir, "2026-10-02-brief.md"), "Brief 2", "utf8");
    assert.throws(() => oracleInput(dir), /Ambiguous/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Parse requirement types and statuses incl. pipes inside quotes
// ---------------------------------------------------------------------------

test("parseRequirement: extracts types R, Ri, G, A, D", () => {
  assert.deepEqual(
    parseRequirement("| R01 | User requirement | Acceptance | in-spec |"),
    { id: "R01", type: "R", status: "in-spec" }
  );
  assert.deepEqual(
    parseRequirement("| Ri02 | Internal improvement | Acceptance | done |"),
    { id: "Ri02", type: "Ri", status: "done" }
  );
  assert.deepEqual(
    parseRequirement("| G01 | Goal statement | Acceptance | in-ticket |"),
    { id: "G01", type: "G", status: "in-ticket" }
  );
  assert.deepEqual(
    parseRequirement("| A01 | Assumption statement | Acceptance | deferred |"),
    { id: "A01", type: "A", status: "deferred" }
  );
  assert.deepEqual(
    parseRequirement("| D01 | Dropped feature | Acceptance | dropped |"),
    { id: "D01", type: "D", status: "dropped" }
  );
});

test("parseRequirement: handles all 7 statuses", () => {
  for (const status of ALLOWED_STATUSES) {
    const row = `| R10 | Test req | Acc | ${status} |`;
    const parsed = parseRequirement(row);
    assert.ok(parsed, `Should parse status '${status}'`);
    assert.equal(parsed.status, status);
  }
});

test("parseRequirement: respects pipes inside quotes «...»", () => {
  const row = '| R05 | «весь их функционал» + «Mode/depth dials: --mode | --depth в start.» | start accepts dials | open |';
  const parsed = parseRequirement(row);
  assert.deepEqual(parsed, {
    id: "R05",
    type: "R",
    status: "open",
  });
});

test("parseRequirement: ignores non-requirement rows", () => {
  assert.equal(parseRequirement("| ID | Requirement | Acceptance | Status |"), null);
  assert.equal(parseRequirement("|---|---|---|---|"), null);
  assert.equal(parseRequirement("## Settled constraints"), null);
  assert.equal(parseRequirement(""), null);
});

// ---------------------------------------------------------------------------
// 6. Recount mechanically derives counts per status and type
// ---------------------------------------------------------------------------

test("recount: derives counts from manifest table rows", () => {
  const manifest = `
| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| R01 | «Dial flags» | start accepts dials | open |
| R02 | «Secret redaction» | secrets redacted | in-spec |
| R03 | «Plan check» | check-plan runs | in-ticket |
| Ri01 | «Internal refactor» | code cleaned | done |
| G01 | «Goal 1» | achieved | placeholder |
| A01 | «Assumption 1» | noted | deferred |
| D01 | «Dropped req» | removed | dropped |
`;

  const counts = recount(manifest);
  assert.equal(counts.total, 7);

  // Per status
  assert.equal(counts.byStatus["open"], 1);
  assert.equal(counts.byStatus["in-spec"], 1);
  assert.equal(counts.byStatus["in-ticket"], 1);
  assert.equal(counts.byStatus["done"], 1);
  assert.equal(counts.byStatus["placeholder"], 1);
  assert.equal(counts.byStatus["deferred"], 1);
  assert.equal(counts.byStatus["dropped"], 1);

  // Per type
  assert.equal(counts.byType["R"], 3);
  assert.equal(counts.byType["Ri"], 1);
  assert.equal(counts.byType["G"], 1);
  assert.equal(counts.byType["A"], 1);
  assert.equal(counts.byType["D"], 1);

  // Top-level conveniences
  assert.equal(counts.open, 1);
  assert.equal(counts["in-spec"], 1);
  assert.equal(counts.R, 3);
  assert.equal(counts.Ri, 1);
});

test("recount: reflects status updates without manual tally", () => {
  const initialRows = [
    "| R01 | Req 1 | Acc | open |",
    "| R02 | Req 2 | Acc | open |",
  ];
  const initialCounts = recount(initialRows);
  assert.equal(initialCounts.total, 2);
  assert.equal(initialCounts.open, 2);
  assert.equal(initialCounts.done, 0);

  const updatedRows = [
    "| R01 | Req 1 | Acc | done |",
    "| R02 | Req 2 | Acc | in-spec |",
  ];
  const updatedCounts = recount(updatedRows);
  assert.equal(updatedCounts.total, 2);
  assert.equal(updatedCounts.open, 0);
  assert.equal(updatedCounts.done, 1);
  assert.equal(updatedCounts["in-spec"], 1);
});
