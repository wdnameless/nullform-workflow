import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { collectNeeded, collectBlind, checksAge, runStatusOf } from "../dashboard-needed.mjs";
import { SHELL_CSS, SHELL_CLIENT_JS } from "../dashboard-shell-client.mjs";

const WORKFLOW = join(import.meta.dirname, "..", "workflow.mjs");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "apple-shell-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "openspec", "changes", "demo"), { recursive: true });
  writeFileSync(join(root, ".env.example"), [
    "# names only",
    "STRIPE_SECRET_KEY=",
    "export TELEGRAM_TOKEN=changeme",
    "not a var",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "src", "a.mjs"), [
    "// TODO: wire this up",
    'const label = "placeholder";',
    "const key = 'PLACEHOLDER_TOKEN';",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "openspec", "changes", "demo", "manifest.md"), [
    "| ID | Quote | Acceptance | Status |",
    "| --- | --- | --- | --- |",
    "| R01 | «сделай» | works | verified |",
    "| R02 | «и вот это» | works | assumption |",
  ].join("\n"), "utf8");
  return root;
}

test("collectNeeded: env keys are names, never values", () => {
  const root = fixture();
  try {
    const n = collectNeeded(root);
    assert.deepEqual(n.envKeys, ["STRIPE_SECRET_KEY", "TELEGRAM_TOKEN"]);
    for (const k of n.envKeys) assert.ok(!/secret|changeme/i.test(k.replace("_SECRET_", "")), "only the name travels");
    assert.ok(!JSON.stringify(n).includes("changeme"), "a value in the template must not reach the result");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectNeeded: placeholders use exact markers, so a status literal is not a finding", () => {
  const root = fixture();
  try {
    const n = collectNeeded(root);
    const texts = n.placeholders.map((p) => p.text);
    assert.ok(texts.some((t) => t.includes("TODO: wire this up")), "a real TODO is found");
    assert.ok(texts.some((t) => t.includes("PLACEHOLDER_TOKEN")), "an upper-case marker is found");
    assert.ok(!texts.some((t) => t === 'const label = "placeholder";'), "a lower-case status literal is not a placeholder");
    assert.deepEqual(
      n.placeholders.map((p) => [p.file, p.line]),
      [["src/a.mjs", 1], ["src/a.mjs", 3]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectNeeded: assumptions come from the manifest status column", () => {
  const root = fixture();
  try {
    const n = collectNeeded(root, { manifestPath: join(root, "openspec", "changes", "demo", "manifest.md") });
    assert.equal(n.assumptions.length, 1);
    assert.match(n.assumptions[0], /^R02 —/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectNeeded: a clean project returns three empty lists, not null", () => {
  const root = mkdtempSync(join(tmpdir(), "apple-shell-clean-"));
  try {
    const n = collectNeeded(root);
    assert.deepEqual(n, { envKeys: [], placeholders: [], assumptions: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectBlind: proven counts as matched, partial and missing become disagreements", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "openspec", "changes", "demo", "oracle.md"), [
      "# Verdict — demo",
      "",
      "| ID | Verdict | Evidence | Note |",
      "| --- | --- | --- | --- |",
      "| R01 | proven | ran it | fine |",
      "| R02 | partially | ran it | status not visible |",
      "| R03 | missing | — | no CLI |",
      "| R04 | proven | ran it | fine |",
    ].join("\n"), "utf8");
    const b = collectBlind(root, "demo");
    assert.equal(b.checked, 4);
    assert.equal(b.matched, 2);
    assert.equal(b.disagreements.length, 2);
    assert.match(b.disagreements[0], /^R02 —/);
    assert.match(b.disagreements[1], /^R03 —/);
    assert.match(b.source, /demo\/oracle\.md$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectBlind: no oracle file means no card, not an empty card", () => {
  const root = fixture();
  try {
    assert.equal(collectBlind(root, "demo"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectBlind: a table of headers alone does not count as checked", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "openspec", "changes", "demo", "oracle.md"), [
      "| ID | Verdict | Evidence | Note |",
      "| --- | --- | --- | --- |",
      "",
      "Verdict: ACCEPT",
    ].join("\n"), "utf8");
    assert.equal(collectBlind(root, "demo"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checksAge: an old cache is stale, a fresh one is not, a dateless one is never fresh", () => {
  const old = checksAge({ generatedAt: new Date(Date.now() - 32 * 86400000).toISOString() });
  assert.equal(old.stale, true);
  assert.ok(old.days >= 32);
  assert.equal(checksAge({ generatedAt: new Date().toISOString() }).stale, false);
  assert.deepEqual(checksAge({}), { days: null, stale: true }, "no date cannot mean fresh");
  assert.deepEqual(checksAge(null), { days: null, stale: false }, "no cache at all is not stale");
});

test("runStatusOf: an open wait is its own state", () => {
  assert.equal(runStatusOf({ status: "open", waiting: { from: "x" } }), "waiting");
  assert.equal(runStatusOf({ status: "open" }), "open");
  assert.equal(runStatusOf({ status: "closed", waiting: { from: "x" } }), "closed");
});

test("workflow ask/answered: the wait is recorded and the working clock stops", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-cli-"));
  const run = (...args) => execFileSync(process.execPath, [WORKFLOW, ...args, "--root", root], { encoding: "utf8", stdio: "pipe" });
  try {
    run("start", "--tier", "T1", "--task", "probe", "--no-dashboard");
    run("ask", "briefing", "--note", "round one");
    const mid = JSON.parse(execFileSync(process.execPath, ["-e", `
      const s = require(${JSON.stringify(join(root, ".workflow", "state.json"))});
      process.stdout.write(JSON.stringify({ waiting: s.waiting, waits: s.waits || [] }));
    `], { encoding: "utf8" }));
    assert.equal(mid.waiting.kind, "briefing");
    assert.equal(mid.waiting.note, "round one");
    assert.equal(mid.waits.length, 0, "an open wait is not yet an interval");

    run("answered");
    const after = JSON.parse(execFileSync(process.execPath, ["-e", `
      const s = require(${JSON.stringify(join(root, ".workflow", "state.json"))});
      process.stdout.write(JSON.stringify({ waiting: s.waiting ?? null, waits: s.waits || [] }));
    `], { encoding: "utf8" }));
    assert.equal(after.waiting, null);
    assert.equal(after.waits.length, 1);
    assert.equal(after.waits[0].kind, "briefing");
    assert.ok(after.waits[0].durationMs >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow ask: a repeated ask keeps the original start, and an unknown kind is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-cli2-"));
  const run = (...args) => execFileSync(process.execPath, [WORKFLOW, ...args, "--root", root], { encoding: "utf8", stdio: "pipe" });
  const state = () => JSON.parse(execFileSync(process.execPath, ["-e", `
    process.stdout.write(JSON.stringify(require(${JSON.stringify(join(root, ".workflow", "state.json"))})));
  `], { encoding: "utf8" }));
  try {
    run("start", "--tier", "T1", "--task", "probe", "--no-dashboard");
    run("ask", "plan", "--note", "first");
    const first = state().waiting.from;
    run("ask", "plan", "--note", "repeated");
    assert.equal(state().waiting.from, first, "a repeated note must not reset the clock the human is measured against");

    assert.throws(() => execFileSync(process.execPath, [WORKFLOW, "ask", "nonsense", "--root", root], { encoding: "utf8", stdio: "pipe" }),
      /Command failed/, "an unknown kind is a usage error, not a new state");
    assert.equal(state().waiting.kind, "plan", "the refused call did not change the state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow answered: with nothing waiting it is a no-op, not an error", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-cli3-"));
  try {
    execFileSync(process.execPath, [WORKFLOW, "start", "--tier", "T1", "--task", "probe", "--no-dashboard", "--root", root], { encoding: "utf8", stdio: "pipe" });
    const out = execFileSync(process.execPath, [WORKFLOW, "answered", "--root", root], { encoding: "utf8", stdio: "pipe" });
    assert.match(out, /nothing was waiting/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell CSS: materials, size-specific tracking, compositor-only motion", () => {
  assert.match(SHELL_CSS, /backdrop-filter:\s*blur\(\d+px\)\s*saturate/, "chrome is a blurred material");
  assert.match(SHELL_CSS, /header\s*\{[^}]*backdrop-filter/, "the header itself carries the material");
  assert.match(SHELL_CSS, /clamp\([^)]*\)/, "display type scales");
  assert.match(SHELL_CSS, /letter-spacing:\s*-0\.0/, "display tracking is negative");
  assert.match(SHELL_CSS, /letter-spacing:\s*0\.0[1-9]/, "micro-labels get positive tracking");
  assert.ok(!/\*\s*\{[^}]*letter-spacing/.test(SHELL_CSS), "no single tracking value for every element");
  assert.ok(!/animation:[^;]*\b(width|height|margin|padding)\b/.test(SHELL_CSS), "no layout is animated");
  assert.match(SHELL_CSS, /:active\s*\{\s*transform:\s*scale/, "feedback lands on press, not release");
});

test("shell CSS: three independent accessibility signals", () => {
  assert.match(SHELL_CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(SHELL_CSS, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(SHELL_CSS, /@media \(prefers-contrast: more\)/);
  assert.match(SHELL_CSS, /prefers-reduced-transparency: reduce\)\s*\{[^}]*backdrop-filter:\s*none/, "transparency preference removes blur");
});

test("shell client: empty data collapses the card instead of drawing a hollow box", () => {
  assert.match(SHELL_CLIENT_JS, /host\.style\.display = "none"/);
  assert.match(SHELL_CLIENT_JS, /function renderNeeded/);
  assert.match(SHELL_CLIENT_JS, /function renderBlind/);
  assert.match(SHELL_CLIENT_JS, /function renderChecksAge/);
});
