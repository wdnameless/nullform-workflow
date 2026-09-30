import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cmdRecord,
  cmdReplay,
  cmdVerify,
  loadCassette,
  requestKey,
  redactHeaders,
  redactUrl,
  redactBody,
} from "../replay.mjs";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

test("requestKey and redaction helpers behave deterministically", () => {
  const key = requestKey("POST", "/v1/chat/completions?model=test", '{"query":"hello"}');
  assert.match(key, /^POST \/v1\/chat\/completions\?model=test \[[a-f0-9]{12}\]$/);

  const redacted = redactHeaders({
    authorization: "Bearer secret-token",
    host: "api.openrouter.ai",
    "x-api-key": "secret-key",
    date: "Wed, 30 Sep 2026 12:00:00 GMT",
  });
  assert.equal(redacted.authorization, "[REDACTED]");
  assert.equal(redacted["x-api-key"], "[REDACTED]");
  assert.equal(redacted.host, "api.openrouter.ai");
  assert.equal(redacted.date, undefined, "Volatile date header must be removed");

  const cleanUrl = redactUrl("/auth?token=supersecret&api_key=12345&foo=bar");
  assert.match(cleanUrl, /token=\[REDACTED\]/);
  assert.match(cleanUrl, /api_key=\[REDACTED\]/);
  assert.match(cleanUrl, /foo=bar/);
});

test("cmdRecord sets upstream Host header to base.host and records cassette", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "replay-test-"));
  const cassettePath = join(tmpDir, "cassette.json");

  let receivedHost = null;
  let receivedAuth = null;
  const upstreamServer = createServer((req, res) => {
    receivedHost = req.headers.host;
    receivedAuth = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", upstreamReceivedHost: receivedHost }));
  });

  const upstreamPort = await getFreePort();
  await new Promise((resolve) => upstreamServer.listen(upstreamPort, "127.0.0.1", resolve));

  const proxyPort = await getFreePort();
  const targetUrl = `http://127.0.0.1:${upstreamPort}`;
  const proxyServer = await cmdRecord(cassettePath, proxyPort, targetUrl, null);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test`, {
      method: "POST",
      headers: { authorization: "Bearer secret-test-token", "content-type": "application/json" },
      body: JSON.stringify({ ping: "pong" }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "ok");
    assert.equal(receivedHost, `127.0.0.1:${upstreamPort}`, "Upstream must receive target base.host, not proxy host");
    assert.equal(receivedAuth, "Bearer secret-test-token");

    const cassette = loadCassette(cassettePath);
    assert.ok(cassette, "Cassette must be saved");
    assert.equal(cassette.target, targetUrl);
    assert.equal(cassette.interactions.length, 1);
    assert.equal(cassette.interactions[0].request.headers.authorization, "[REDACTED]");
    assert.equal(cassette.interactions[0].request.headers.host, `127.0.0.1:${upstreamPort}`);
  } finally {
    proxyServer.close();
    upstreamServer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cmdRecord filter pass-through routes without recording and preserves upstream Host header", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "replay-filter-"));
  const cassettePath = join(tmpDir, "cassette.json");

  let filterReceivedHost = null;
  const upstreamServer = createServer((req, res) => {
    filterReceivedHost = req.headers.host;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("filtered-passthrough");
  });

  const upstreamPort = await getFreePort();
  await new Promise((resolve) => upstreamServer.listen(upstreamPort, "127.0.0.1", resolve));

  const proxyPort = await getFreePort();
  const targetUrl = `http://127.0.0.1:${upstreamPort}`;
  const proxyServer = await cmdRecord(cassettePath, proxyPort, targetUrl, "^/recorded");

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/passthrough/auth`, { method: "GET" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "filtered-passthrough");
    assert.equal(filterReceivedHost, `127.0.0.1:${upstreamPort}`, "Filtered pass-through must set upstream Host header");

    const cassette = loadCassette(cassettePath);
    assert.equal(cassette?.interactions?.length || 0, 0, "Pass-through request must not be recorded in cassette");
  } finally {
    proxyServer.close();
    upstreamServer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cmdReplay serves recorded responses deterministically without upstream", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "replay-serve-"));
  const cassettePath = join(tmpDir, "cassette.json");

  const interactionKey = requestKey("GET", "/mock/resource", "");
  const cassetteContent = {
    version: 1,
    recordedAt: "2026-09-30",
    target: "https://api.openrouter.ai",
    interactions: [{
      key: interactionKey,
      request: { method: "GET", url: "/mock/resource", headers: {}, body: null },
      response: { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ cached: true }) },
    }],
  };
  writeFileSync(cassettePath, JSON.stringify(cassetteContent, null, 2));

  const replayPort = await getFreePort();
  const replayServer = cmdReplay(cassettePath, replayPort, true);

  try {
    const res = await fetch(`http://127.0.0.1:${replayPort}/mock/resource`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { cached: true });

    const unmatched = await fetch(`http://127.0.0.1:${replayPort}/not/recorded`);
    assert.equal(unmatched.status, 501, "Unmatched request must return 501");
  } finally {
    replayServer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cmdVerify validates cassette structure and detects unredacted secrets", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "replay-verify-"));
  const validPath = join(tmpDir, "valid.json");
  const leakPath = join(tmpDir, "leak.json");

  writeFileSync(validPath, JSON.stringify({
    version: 1, recordedAt: "2026-09-30", target: "https://example.com",
    interactions: [{
      key: "GET / 00000000",
      request: { method: "GET", url: "/", headers: {}, body: null },
      response: { status: 200, headers: {}, body: "ok" },
    }],
  }));

  writeFileSync(leakPath, JSON.stringify({
    version: 1, recordedAt: "2026-09-30", target: "https://example.com",
    interactions: [{
      key: "GET / 00000000",
      request: { method: "GET", url: "/", headers: { authorization: "Bearer sk-live-secret" }, body: null },
      response: { status: 200, headers: {}, body: "ok" },
    }],
  }));

  try {
    assert.equal(cmdVerify(validPath), 0, "Valid cassette must pass verify");
    assert.equal(cmdVerify(leakPath), 1, "Cassette with unredacted secret must fail verify");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cmdRecord preserves gzip compressed upstream and cmdReplay serves consumer without ZlibError", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "replay-gzip-"));
  const cassettePath = join(tmpDir, "cassette.json");

  const expectedData = { models: [{ id: "google/gemini-3.1-flash-lite" }] };
  const upstreamServer = createServer((req, res) => {
    const compressed = gzipSync(Buffer.from(JSON.stringify(expectedData), "utf8"));
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(compressed);
  });

  const upstreamPort = await getFreePort();
  await new Promise((resolve) => upstreamServer.listen(upstreamPort, "127.0.0.1", resolve));

  const proxyPort = await getFreePort();
  const targetUrl = `http://127.0.0.1:${upstreamPort}`;
  const proxyServer = await cmdRecord(cassettePath, proxyPort, targetUrl, null);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/models`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), expectedData, "Client must successfully decode gzipped body without ZlibError");

    const cassette = loadCassette(cassettePath);
    assert.ok(cassette, "Cassette must be recorded");
    assert.equal(cassette.interactions.length, 1);
    assert.equal(cassette.interactions[0].response.headers["content-encoding"], undefined, "Cassette must omit content-encoding header");
    assert.deepEqual(JSON.parse(cassette.interactions[0].response.body), expectedData, "Cassette body must be decompressed text");
  } finally {
    proxyServer.close();
    upstreamServer.close();
  }

  const replayPort = await getFreePort();
  const replayServer = cmdReplay(cassettePath, replayPort, true);
  try {
    const replayRes = await fetch(`http://127.0.0.1:${replayPort}/api/v1/models`);
    assert.equal(replayRes.status, 200);
    assert.deepEqual(await replayRes.json(), expectedData, "Replayed response must be parsed cleanly by consumer");
  } finally {
    replayServer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("redactBody preserves valid JSON with signature and escaped quotes", () => {
  const original = JSON.stringify({
    id: "gen-123",
    choices: [{ message: { role: "assistant", content: "hello world" } }],
    signature: 'sig_secret_key_12345"with\\"escaped\\"quotes_and_tail',
    api_key: "sk-or-v1-secret987654321",
    nested: { secret: "super-secret-token" },
  });

  const redacted = redactBody(original);
  assert.doesNotMatch(redacted, /sig_secret_key_12345/);
  assert.doesNotMatch(redacted, /sk-or-v1-secret987654321/);
  assert.doesNotMatch(redacted, /super-secret-token/);
  assert.doesNotMatch(redacted, /escaped/);

  const parsed = JSON.parse(redacted);
  assert.equal(parsed.id, "gen-123");
  assert.equal(parsed.signature, "[REDACTED]");
  assert.equal(parsed.api_key, "[REDACTED]");
  assert.equal(parsed.nested.secret, "[REDACTED]");
  assert.equal(parsed.choices[0].message.content, "hello world");
});

test("cmdVerify catches malformed JSON body when content-type is application/json", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "replay-malformed-json-"));
  const malformedPath = join(tmpDir, "malformed.json");
  const ssePath = join(tmpDir, "sse.json");

  writeFileSync(malformedPath, JSON.stringify({
    version: 1, recordedAt: "2026-09-30", target: "https://example.com",
    interactions: [{
      key: "POST /v1/chat/completions 00000000",
      request: { method: "POST", url: "/v1/chat/completions", headers: {}, body: "{}" },
      response: { status: 200, headers: { "content-type": "application/json" }, body: '{"signature": [REDACTED]}' },
    }],
  }));

  writeFileSync(ssePath, JSON.stringify({
    version: 1, recordedAt: "2026-09-30", target: "https://example.com",
    interactions: [{
      key: "POST /v1/chat/completions 00000000",
      request: { method: "POST", url: "/v1/chat/completions", headers: {}, body: "{}" },
      response: { status: 200, headers: { "content-type": "text/event-stream" }, body: "data: {\"model\":\"test\"}\n\ndata: [DONE]\n\n" },
    }],
  }));

  try {
    assert.equal(cmdVerify(malformedPath), 1, "Malformed JSON body must fail cmdVerify");
    assert.equal(cmdVerify(ssePath), 0, "Valid SSE stream must pass cmdVerify");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
