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
import {
  parseModelsYaml,
  loadPriorityList,
  resolveOracleModel,
  updateConfigYaml,
  redactSecrets,
  collectAvailableModels,
} from "../oracle-model.mjs";

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
