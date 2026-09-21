/**
 * tools/tests/oracle-model.test.mjs
 *
 * Unit and regression tests for oracle-model.mjs:
 * 1. models.yml parsing (declared, 2-space providers, discovery.type)
 * 2. priority resolution order (case-insensitive substring match)
 * 3. fallback when no match is available (gemini-3.8-flash-high)
 * 4. config.yml write preserves unrelated lines (byte-by-byte compare except the two oracle lines)
 * 5. idempotency (second run yields modified: false and unchanged content)
 * 6. secrets never leak in output (apiKey redacted across output paths)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  parseModelsYaml,
  loadPriorityList,
  resolveOracleModel,
  updateConfigYaml,
  redactSecrets,
  collectAvailableModels,
} from "../oracle-model.mjs";

const ORACLE_PATH = resolve(import.meta.dirname, "../oracle-model.mjs");

test("models.yml parsing: declared providers, models (- id:), discovery type, baseUrl, apiKey", () => {
  const sampleYaml = `
providers:
  my-provider:
    baseUrl: https://api.openai.com/v1
    apiKey: sk-secret-token-12345
    discovery:
      type: openai-compatible
    models:
      - id: gpt-4o
      - id: gpt-4o-mini
  anthropic:
    baseUrl: https://api.anthropic.com/v1
    apiKey: ant-secret-token-67890
    models:
      - id: claude-3-5-sonnet
`;

  const parsed = parseModelsYaml(sampleYaml);
  assert.ok(parsed.providers["my-provider"], "my-provider parsed");
  assert.equal(parsed.providers["my-provider"].baseUrl, "https://api.openai.com/v1");
  assert.equal(parsed.providers["my-provider"].apiKey, "sk-secret-token-12345");
  assert.equal(parsed.providers["my-provider"].discovery?.type, "openai-compatible");
  assert.deepEqual(parsed.providers["my-provider"].models, ["gpt-4o", "gpt-4o-mini"]);

  assert.ok(parsed.providers["anthropic"], "anthropic parsed");
  assert.equal(parsed.providers["anthropic"].baseUrl, "https://api.anthropic.com/v1");
  assert.equal(parsed.providers["anthropic"].apiKey, "ant-secret-token-67890");
  assert.equal(parsed.providers["anthropic"].discovery, null);
  assert.deepEqual(parsed.providers["anthropic"].models, ["claude-3-5-sonnet"]);
});

test("priority resolution order: case-insensitive substring match respects priority ordering", () => {
  const priorityEntries = [
    { match: "claude-3-7-sonnet", why: "Strongest" },
    { match: "claude-3-5-sonnet", why: "Second strongest" },
    { match: "gpt-4o", why: "Third" },
    { match: "gemini-3.8-flash-high", why: "Fallback" },
  ];

  const available = [
    { qualified: "provider-a/gpt-4o", provider: "provider-a", model: "gpt-4o", source: "declared" },
    { qualified: "provider-b/Claude-3-5-Sonnet-20241022", provider: "provider-b", model: "Claude-3-5-Sonnet-20241022", source: "declared" },
  ];

  // Even though gpt-4o is first in available, claude-3-5-sonnet has higher priority in priorityEntries
  const res = resolveOracleModel(priorityEntries, available);
  assert.equal(res.resolved, "provider-b/Claude-3-5-Sonnet-20241022");
  assert.equal(res.matchedEntry, "claude-3-5-sonnet");
  assert.equal(res.isFallback, false);
});

test("fallback when no match is available: resolves to gemini-3.8-flash-high", () => {
  const priorityEntries = [
    { match: "claude-3-7-sonnet", why: "" },
    { match: "claude-3-5-sonnet", why: "" },
    { match: "gemini-3.8-flash-high", why: "Fallback" },
  ];

  const available = [
    { qualified: "local/llama-3-8b", provider: "local", model: "llama-3-8b", source: "declared" },
    { qualified: "local/mistral-7b", provider: "local", model: "mistral-7b", source: "declared" },
  ];

  const res = resolveOracleModel(priorityEntries, available);
  assert.equal(res.resolved, "gemini-3.8-flash-high");
  assert.equal(res.matchedEntry, "gemini-3.8-flash-high");
  assert.equal(res.isFallback, true);
});

test("config.yml write preserves unrelated lines (byte comparison except the two oracle lines)", () => {
  const originalConfig = [
    "# Top comment",
    "modelRoles:",
    "  default: my-provider/gpt-4o-mini",
    "  cheap: my-provider/gpt-4o-mini",
    "  oracle: old-provider/old-oracle-model # existing comment",
    "  designer: my-provider/gpt-4o",
    "",
    "task:",
    "  agentModelOverrides:",
    "    oracle: old-provider/old-oracle-model",
    "    critic: my-provider/gpt-4o",
    "# Bottom comment",
  ].join("\r\n");

  const newOracle = "anthropic/claude-3-5-sonnet";
  const { content: updatedConfig, modified } = updateConfigYaml(originalConfig, newOracle);

  assert.equal(modified, true, "should be modified");

  // Split lines and verify line by line
  const origLines = originalConfig.split("\r\n");
  const updatedLines = updatedConfig.split("\r\n");

  assert.equal(origLines.length, updatedLines.length, "line count must match");

  for (let i = 0; i < origLines.length; i++) {
    const orig = origLines[i];
    const updated = updatedLines[i];
    if (orig.includes("oracle:")) {
      assert.ok(updated.includes(newOracle), `oracle line ${i} must contain new value`);
      // check indentation preserved
      assert.equal(orig.indexOf("oracle:"), updated.indexOf("oracle:"));
    } else {
      // Unrelated lines must match byte-for-byte
      assert.equal(updated, orig, `Line ${i} must be identical`);
    }
  }

  // Preserve CRLF
  assert.ok(updatedConfig.includes("\r\n"), "must preserve CRLF");
  assert.ok(!updatedConfig.replace(/\r\n/g, "").includes("\n"), "no lone LF introduced");
});

test("idempotency: running updateConfigYaml again on already-updated content produces modified: false", () => {
  const config = [
    "modelRoles:",
    "  oracle: anthropic/claude-3-5-sonnet",
    "task:",
    "  agentModelOverrides:",
    "    oracle: anthropic/claude-3-5-sonnet",
  ].join("\n");

  const firstRun = updateConfigYaml(config, "anthropic/claude-3-5-sonnet");
  assert.equal(firstRun.modified, false);
  assert.equal(firstRun.content, config);
});

test("secrets redaction: apiKey material is never exposed in output text", () => {
  const secrets = ["sk-live-super-secret-key-9999", "another-sensitive-token"];
  const rawLog = "Connecting to provider with key sk-live-super-secret-key-9999 and another-sensitive-token for auth";

  const redacted = redactSecrets(rawLog, secrets);
  assert.ok(!redacted.includes("sk-live-super-secret-key-9999"), "secret must be redacted");
  assert.ok(!redacted.includes("another-sensitive-token"), "secret must be redacted");
  assert.ok(redacted.includes("[REDACTED]"), "redacted marker must be present");
});

// ---------------------------------------------------------------------------
// Reachability (--probe): недостижимый провайдер не должен поставлять модели.
// ---------------------------------------------------------------------------

const DEAD_BASE_URL = "http://127.0.0.1:1/v1";

function modelsYaml(livePort) {
  const lines = [
    "providers:",
    "  dead-provider:",
    `    baseUrl: ${DEAD_BASE_URL}`,
    "    apiKey: sk-oracle-fixture-secret",
    "    models:",
    "      - id: preferred-oracle",
  ];
  if (livePort) {
    lines.push(
      "  live-provider:",
      `    baseUrl: http://127.0.0.1:${livePort}/v1`,
      "    models:",
      "      - id: backup-oracle"
    );
  }
  return lines.join("\n") + "\n";
}

function writePriorityFile(dir, entries) {
  const path = join(dir, "oracle-priority.json");
  writeFileSync(path, JSON.stringify(entries, null, 2), "utf8");
  return path;
}

function writeConfigFile(dir, oracleModel) {
  const path = join(dir, "config.yml");
  writeFileSync(
    path,
    [
      "# fixture config",
      "modelRoles:",
      `  oracle: ${oracleModel}`,
      "  designer: some-provider/designer-model",
      "task:",
      "  agentModelOverrides:",
      `    oracle: ${oracleModel}`,
      "    critic: some-provider/critic-model",
    ].join("\n") + "\n",
    "utf8"
  );
  return path;
}

function runOracle(args) {
  const res = spawnSync(process.execPath, [ORACLE_PATH, ...args], { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Асинхронный запуск: с локальным сервером spawnSync заблокировал бы ответ. */
function runOracleAsync(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [ORACLE_PATH, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const modelsHandler = (req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "backup-oracle" }] }));
};

test("collectAvailableModels(probe=false): сети нет, объявленные модели доступны (поведение прежнее)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "oracle-noprobe-"));
  try {
    const modelsPath = join(tmp, "models.yml");
    writeFileSync(modelsPath, modelsYaml(), "utf8");

    const { available, providers, notes } = await collectAvailableModels(modelsPath, false);

    assert.deepEqual(
      available.map((a) => a.qualified),
      ["dead-provider/preferred-oracle"]
    );
    assert.equal(providers["dead-provider"].reachable, null, "без probe доступность неизвестна");
    assert.deepEqual(notes, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectAvailableModels(probe=true): модели недостижимого провайдера исключены", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "oracle-probe-"));
  try {
    await withServer(modelsHandler, async (port) => {
      const modelsPath = join(tmp, "models.yml");
      writeFileSync(modelsPath, modelsYaml(port), "utf8");

      const { available, providers, notes, secrets } = await collectAvailableModels(modelsPath, true);
      const qualified = available.map((a) => a.qualified);

      assert.equal(providers["dead-provider"].reachable, false);
      assert.equal(providers["live-provider"].reachable, true);
      assert.ok(!qualified.some((q) => q.startsWith("dead-provider/")), "dead provider models excluded");
      assert.ok(qualified.includes("live-provider/backup-oracle"));
      assert.ok(notes.some((n) => /dead-provider недостижим/.test(n)), JSON.stringify(notes));
      assert.deepEqual(secrets, ["sk-oracle-fixture-secret"], "ключи только для редактирования вывода");
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("list --probe --json: недостижимый провайдер помечен, exit 0, ключ не печатается", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "oracle-list-"));
  try {
    await withServer(modelsHandler, async (port) => {
      const modelsPath = join(tmp, "models.yml");
      const configPath = writeConfigFile(tmp, "dead-provider/preferred-oracle");
      const priorityPath = writePriorityFile(tmp, ["preferred-oracle", "backup-oracle"]);
      writeFileSync(modelsPath, modelsYaml(port), "utf8");

      const res = await runOracleAsync([
        "list",
        "--probe",
        "--json",
        "--models",
        modelsPath,
        "--config",
        configPath,
        "--priority",
        priorityPath,
      ]);

      assert.equal(res.status, 0, res.stderr);
      const json = JSON.parse(res.stdout);
      assert.deepEqual(json.unreachableProviders, ["dead-provider"]);
      assert.equal(json.providers["dead-provider"].reachable, false);
      assert.equal(json.providers["live-provider"].reachable, true);
      assert.equal(json.resolved, "live-provider/backup-oracle");
      assert.ok(!res.stdout.includes("sk-oracle-fixture-secret"), "apiKey must never be printed");
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensure --probe: не выбирает модель провалившего провайдера (регресс)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "oracle-ensure-probe-"));
  try {
    await withServer(modelsHandler, async (port) => {
      const modelsPath = join(tmp, "models.yml");
      const priorityPath = writePriorityFile(tmp, ["preferred-oracle", "backup-oracle"]);
      writeFileSync(modelsPath, modelsYaml(port), "utf8");

      // С --probe: первый приоритет (preferred-oracle) живёт у мёртвого провайдера →
      // выбирается следующий доступный (backup-oracle у отвечающего провайдера).
      const probeConfig = writeConfigFile(tmp, "some-provider/current-oracle");
      const withProbe = await runOracleAsync([
        "ensure",
        "--probe",
        "--models",
        modelsPath,
        "--config",
        probeConfig,
        "--priority",
        priorityPath,
      ]);
      assert.equal(withProbe.status, 0, withProbe.stderr);
      const afterProbe = readFileSync(probeConfig, "utf8");
      assert.match(afterProbe, /^ {2}oracle: live-provider\/backup-oracle$/m);
      assert.match(afterProbe, /^ {4}oracle: live-provider\/backup-oracle$/m);
      assert.ok(!afterProbe.includes("dead-provider"), "dead provider must not be written");
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensure без --probe: поведение прежнее (первый приоритет из declared)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oracle-ensure-noprobe-"));
  try {
    const modelsPath = join(tmp, "models.yml");
    const configPath = writeConfigFile(tmp, "some-provider/current-oracle");
    const priorityPath = writePriorityFile(tmp, ["preferred-oracle", "backup-oracle"]);
    writeFileSync(modelsPath, modelsYaml(), "utf8");

    const res = runOracle([
      "ensure",
      "--models",
      modelsPath,
      "--config",
      configPath,
      "--priority",
      priorityPath,
    ]);

    assert.equal(res.status, 0, res.stderr);
    assert.match(readFileSync(configPath, "utf8"), /^ {2}oracle: dead-provider\/preferred-oracle$/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensure --probe: все провайдеры мертвы → модель не выбрана, config.yml не изменён, exit 1", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oracle-ensure-blocked-"));
  try {
    const modelsPath = join(tmp, "models.yml");
    const configPath = writeConfigFile(tmp, "some-provider/current-oracle");
    const priorityPath = writePriorityFile(tmp, ["preferred-oracle", "backup-oracle"]);
    writeFileSync(modelsPath, modelsYaml(), "utf8");
    const before = readFileSync(configPath, "utf8");

    const res = runOracle([
      "ensure",
      "--probe",
      "--models",
      modelsPath,
      "--config",
      configPath,
      "--priority",
      priorityPath,
    ]);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /недостижимы провайдеры dead-provider/);
    assert.match(res.stderr, /config\.yml не изменён/);
    assert.equal(readFileSync(configPath, "utf8"), before, "config must stay byte-identical");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensure --probe --json: отказ сообщается машинно (ok:false, unreachableProviders)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oracle-ensure-json-"));
  try {
    const modelsPath = join(tmp, "models.yml");
    const configPath = writeConfigFile(tmp, "some-provider/current-oracle");
    const priorityPath = writePriorityFile(tmp, ["preferred-oracle"]);
    writeFileSync(modelsPath, modelsYaml(), "utf8");

    const res = runOracle([
      "ensure",
      "--probe",
      "--json",
      "--models",
      modelsPath,
      "--config",
      configPath,
      "--priority",
      priorityPath,
    ]);

    assert.equal(res.status, 1);
    const json = JSON.parse(res.stdout);
    assert.equal(json.ok, false);
    assert.deepEqual(json.unreachableProviders, ["dead-provider"]);
    assert.ok(!res.stdout.includes("sk-oracle-fixture-secret"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
