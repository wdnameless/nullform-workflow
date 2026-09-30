import test from "node:test";
import assert from "node:assert/strict";

import { decide } from "../jev-assist.mjs";

test("decide: returns fallback and zero traffic on screened task (secret canary)", async () => {
  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const res = await decide({
    task: "Look up key sk-or-v1-abcdef0123456789012345",
    apiKey: "valid-key-xyz",
    fetchImpl: mockFetch,
  });

  assert.equal(fetchCalled, false, "Must not make outbound request for screened task");
  assert.equal(res.status, "fallback");
  assert.equal(res.route, "baseline");
  assert.ok(res.reason.startsWith("screened:"));
  assert.equal(res.skill, null);
  assert.equal(res.archetype, "none");
});

test("decide: returns fallback on missing API key with zero traffic", async () => {
  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const res = await decide({
    task: "Format package.json",
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
      text: async () =>
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          usage: {
            input_tokens: 150,
            output_tokens: 30,
            cost: 0.000025,
          },
          answers: {
            skill: {
              choice: "agent-browser",
              confidence: 0.96,
            },
            eligible: {
              noul: 0.98,
            },
            archetype: {
              choice: "lookup",
              confidence: 0.92,
            },
          },
        }),
    };
  };

  const skills = [
    { name: "agent-browser", description: "Browser automation" },
    { name: "git-helper", description: "Git commands" },
  ];

  const res = await decide({
    task: "Check website header using browser automation",
    skills,
    apiKey: "test-key-12345",
    fetchImpl: mockFetch,
  });

  assert.equal(requestedUrl, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(requestHeaders["Authorization"], "Bearer test-key-12345");
  assert.equal(requestHeaders["User-Agent"], "nullform-workflow/jev-assist");
  assert.equal(requestBody.model, "typesafe/jev-1.13");
  assert.ok(requestBody.questions.skill.criteria["agent-browser"]);
  assert.ok(requestBody.questions.skill.criteria["none"]);

  assert.equal(res.status, "ok");
  assert.equal(res.skill, "agent-browser");
  assert.equal(res.route, "cheap");
  assert.equal(res.archetype, "lookup");
  assert.equal(res.model, "typesafe/jev-1.13-20260917");
  assert.equal(res.usage.inputTokens, 150);
  assert.equal(res.usage.outputTokens, 30);
  assert.equal(res.usage.costUsd, 0.000025);
  assert.equal(res.usage.costKnown, true);
});

test("decide: choice 'none' maps skill to null", async () => {
  const mockFetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      model: "typesafe/jev-1.13-20260917",
      usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
      answers: {
        skill: { choice: "none", confidence: 0.99 },
        eligible: { noul: 0.98 },
        archetype: { choice: "formatting", confidence: 0.95 },
      },
    }),
  });

  const res = await decide({
    task: "Format code indentation in config.json",
    skills: [{ name: "some-skill", description: "irrelevant" }],
    apiKey: "key",
    fetchImpl: mockFetch,
  });

  assert.equal(res.status, "ok");
  assert.equal(res.skill, null);
  assert.equal(res.route, "cheap");
  assert.equal(res.archetype, "formatting");
});

test("decide: invented skill from provider is rejected as invalid response", async () => {
  const mockFetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      model: "typesafe/jev-1.13",
      usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
      answers: {
        skill: { choice: "hallucinated-invented-skill", confidence: 0.99 },
        eligible: { noul: 0.98 },
        archetype: { choice: "lookup", confidence: 0.95 },
      },
    }),
  });

  const res = await decide({
    task: "Do something",
    skills: [{ name: "real-skill", description: "desc" }],
    apiKey: "key",
    fetchImpl: mockFetch,
  });

  assert.equal(res.status, "fallback");
  assert.equal(res.reason, "invalid-response");
  assert.equal(res.route, "baseline");
});

test("decide: provider error falls back safely without leaking response body", async () => {
  const mockFetch = async () => ({
    status: 500,
    ok: false,
    text: async () => JSON.stringify({ error: { message: "Internal server error with raw key sk-or-v1-secret" } }),
  });

  const res = await decide({
    task: "Lookup file",
    apiKey: "key",
    fetchImpl: mockFetch,
  });

  assert.equal(res.status, "fallback");
  assert.equal(res.reason, "http-500");
  assert.equal(res.route, "baseline");
  assert.ok(!JSON.stringify(res).includes("sk-or-v1-secret"));
});

test("decide: confirmed repro - rejects out-of-bounds noul, confidence, empty usage, and unknown archetype", async () => {
  const resBadNoul = await decide({
    task: "Sort this json list",
    apiKey: "key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
        answers: {
          skill: { choice: "none", confidence: 0.95 },
          eligible: { noul: 2.0 },
          archetype: { choice: "json-transform", confidence: 0.95 },
        },
      }),
    }),
  });
  assert.equal(resBadNoul.status, "fallback");
  assert.equal(resBadNoul.reason, "invalid-response");

  const resBadConf = await decide({
    task: "Sort this json list",
    apiKey: "key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
        answers: {
          skill: { choice: "none", confidence: -0.1 },
          eligible: { noul: 0.95 },
          archetype: { choice: "json-transform", confidence: 0.95 },
        },
      }),
    }),
  });
  assert.equal(resBadConf.status, "fallback");
  assert.equal(resBadConf.reason, "invalid-response");

  const resBadUsage = await decide({
    task: "Sort this json list",
    apiKey: "key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        usage: null,
        answers: {
          skill: { choice: "none", confidence: 0.95 },
          eligible: { noul: 0.95 },
          archetype: { choice: "json-transform", confidence: 0.95 },
        },
      }),
    }),
  });
  assert.equal(resBadUsage.status, "fallback");
  assert.equal(resBadUsage.reason, "invalid-response");

  const resBadArch = await decide({
    task: "Sort this json list",
    apiKey: "key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
        answers: {
          skill: { choice: "none", confidence: 0.95 },
          eligible: { noul: 0.95 },
          archetype: { choice: "full-autonomous-rewrite", confidence: 0.95 },
        },
      }),
    }),
  });
  assert.equal(resBadArch.status, "fallback");
  assert.equal(resBadArch.reason, "invalid-response");
});

test("decide: conservative thresholds - low eligibility or low archetype confidence retains baseline route", async () => {
  const resLowElig = await decide({
    task: "Format code indentation in config.json",
    apiKey: "key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
        answers: {
          skill: { choice: "none", confidence: 0.99 },
          eligible: { noul: 0.94 },
          archetype: { choice: "formatting", confidence: 0.99 },
        },
      }),
    }),
  });
  assert.equal(resLowElig.status, "ok");
  assert.equal(resLowElig.route, "baseline");

  const resLowArchConf = await decide({
    task: "Format code indentation in config.json",
    apiKey: "key",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        model: "typesafe/jev-1.13",
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
        answers: {
          skill: { choice: "none", confidence: 0.99 },
          eligible: { noul: 0.99 },
          archetype: { choice: "formatting", confidence: 0.89 },
        },
      }),
    }),
  });
  assert.equal(resLowArchConf.status, "ok");
  assert.equal(resLowArchConf.route, "baseline");
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
      skill: { choice: "none", confidence: 0.99 },
      eligible: { noul: 0.98 },
      archetype: { choice: "lookup", confidence: 0.96 },
    },
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cost: 0.00001,
    },
  });

  const realFetch = async () => new Response(payload, { status: 200, headers: { "Content-Type": "application/json" } });

  const res = await decide({
    task: "Read package.json file",
    apiKey: "key",
    fetchImpl: realFetch,
  });

  assert.equal(res.status, "ok");
  assert.equal(res.route, "cheap");
  assert.equal(res.archetype, "lookup");
  assert.equal(res.confidence, 0.96);
  assert.equal(res.model, "typesafe/jev-1.13-20260917");
  assert.equal(res.usage.costUsd, 0.00001);
});

test("decide boundary: unknown usage and missing cost sets costKnown false, preserved on malformed answers", async () => {
  const resTimeout = await decide({
    task: "Lookup file",
    apiKey: "test-key",
    timeoutMs: 1,
    fetchImpl: () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10)),
  });
  assert.equal(resTimeout.status, "fallback");
  assert.equal(resTimeout.usage.costKnown, false);

  const resHttp = await decide({
    task: "Lookup file",
    apiKey: "test-key",
    fetchImpl: async () => ({ status: 503, ok: false }),
  });
  assert.equal(resHttp.status, "fallback");
  assert.equal(resHttp.usage.costKnown, false);

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
