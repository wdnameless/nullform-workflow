import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  hashPrompt,
  hashRecordedPrompt,
  normalizePrompt,
  redactText,
  findUnredactedSecret,
  recordCassette,
  replayCassette,
  verifyCassette,
} from "../lm-replay.mjs";
import { runBenchmark } from "../benchmark.mjs";
import { createTempDir, createGitRepo } from "./test-helpers.mjs";

const CLI_PATH = fileURLToPath(new URL("../lm-replay.mjs", import.meta.url));

test("normalizePrompt and hashPrompt behave deterministically", () => {
  const raw = "  Hello   \n\t  world!  \n ";
  const norm = normalizePrompt(raw);
  assert.equal(norm, "Hello world!");

  const hash1 = hashPrompt(raw);
  const hash2 = hashPrompt("Hello world!");
  assert.equal(hash1, hash2);
  assert.match(hash1, /^[a-f0-9]{64}$/);
});

test("redactText and findUnredactedSecret handle keys, tokens, and bearer auth", () => {
  const secretPayload = JSON.stringify({
    api_key: "sk-proj-1234567890abcdef123456",
    token: "ghp_1234567890abcdef123456",
    message: "Authorization: Bearer mysecrettoken123456789",
    normal: "normal text",
  });

  const foundSecret = findUnredactedSecret(secretPayload);
  assert.ok(foundSecret, "must detect unredacted secret");

  const redacted = redactText(secretPayload);
  assert.doesNotMatch(redacted, /sk-proj-1234567890abcdef123456/);
  assert.doesNotMatch(redacted, /ghp_1234567890abcdef123456/);
  assert.doesNotMatch(redacted, /mysecrettoken123456789/);

  const leakAfterRedact = findUnredactedSecret(redacted);
  assert.equal(leakAfterRedact, null, "redacted payload must have no leaks");
});

test("record -> replay hit byte-for-byte from session.jsonl", () => {
  const tmpDir = createTempDir("lm-replay-hit-");
  try {
    const sessionFile = join(tmpDir, "session.jsonl");
    const cassetteFile = join(tmpDir, "cassette.json");

    const promptText = "Calculate the answer for 6 * 7.";
    const responseText = "The exact answer is 42.";

    const events = [
      { type: "session_start", selector: "provider/test-model" },
      { type: "message", message: { role: "user", content: promptText } },
      {
        type: "message",
        message: {
          role: "assistant",
          model: "test-model",
          content: responseText,
          usage: { input: 15, output: 5, cost: { total: 0.002 } },
        },
      },
    ];
    writeFileSync(sessionFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const cassette = recordCassette({
      from: sessionFile,
      out: cassetteFile,
    });

    assert.equal(cassette.version, 1);
    assert.equal(cassette.model, "provider/test-model");
    assert.equal(cassette.turns.length, 1);
    assert.equal(cassette.turns[0].prompt, promptText);
    assert.equal(cassette.turns[0].response, responseText);
    assert.equal(cassette.turns[0].promptHash, hashPrompt(promptText));

    // Programmatic replay with whitespace variants
    const replayRes = replayCassette(cassetteFile, "   Calculate the answer   for 6 * 7.  \n");
    assert.equal(replayRes.hit, true);
    assert.equal(replayRes.response, responseText, "replayed response must match byte-for-byte");

    // CLI replay
    const promptArgFile = join(tmpDir, "prompt.txt");
    writeFileSync(promptArgFile, promptText, "utf8");
    const cliRes = spawnSync(process.execPath, [CLI_PATH, "replay", "--cassette", cassetteFile, "--prompt", `@${promptArgFile}`], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cliRes.status, 0);
    assert.equal(cliRes.stdout, responseText);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("replay miss / prompt drift under --strict exits 1 naming prompt hash", () => {
  const tmpDir = createTempDir("lm-replay-miss-");
  try {
    const cassetteFile = join(tmpDir, "cassette.json");
    const originalPrompt = "Original task instructions";
    const driftedPrompt = "Changed task instructions with drift";
    const expectedHash = hashPrompt(driftedPrompt);

    recordCassette({
      prompt: originalPrompt,
      response: "Recorded response",
      out: cassetteFile,
      model: "test-model",
    });

    // Programmatic replay without strict
    const softRes = replayCassette(cassetteFile, driftedPrompt, { strict: false });
    assert.equal(softRes.hit, false);
    assert.equal(softRes.promptHash, expectedHash);

    // Programmatic replay with strict
    assert.throws(
      () => replayCassette(cassetteFile, driftedPrompt, { strict: true }),
      (err) => err.code === "STALE" && err.message.includes(expectedHash)
    );

    // CLI replay under --strict
    const cliRes = spawnSync(process.execPath, [CLI_PATH, "replay", "--cassette", cassetteFile, "--prompt", driftedPrompt, "--strict"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cliRes.status, 1);
    assert.match(cliRes.stderr, new RegExp(`STALE prompt drift \\(hash: ${expectedHash}\\)`));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("verify ok on valid cassette and fails naming offending turn on secrets", () => {
  const tmpDir = createTempDir("lm-replay-verify-");
  try {
    const validFile = join(tmpDir, "valid.json");
    const leakFile = join(tmpDir, "leak.json");

    recordCassette({
      prompt: "Safe user prompt",
      response: "Safe assistant response",
      out: validFile,
      model: "test-model",
    });

    const verifyOk = verifyCassette(validFile);
    assert.equal(verifyOk, 0, "clean cassette must pass verify");

    // Manually create cassette with an unredacted secret
    const leakedPrompt = 'Secret prompt with "api_key": "sk-live-supersecret123456789"';
    const leakCassette = {
      version: 1,
      model: "test-model",
      recordedAt: new Date().toISOString(),
      turns: [
        {
          promptHash: hashPrompt(leakedPrompt),
          prompt: leakedPrompt,
          response: "Some answer",
          usage: { input: 1, output: 1 },
        },
      ],
    };
    writeFileSync(leakFile, JSON.stringify(leakCassette, null, 2), "utf8");

    const verifyLeak = verifyCassette(leakFile);
    assert.equal(verifyLeak, 1, "cassette with unredacted secret must fail verify");

    // CLI verify
    const cliRes = spawnSync(process.execPath, [CLI_PATH, "verify", "--cassette", leakFile], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cliRes.status, 1);
    assert.match(cliRes.stdout + cliRes.stderr, /turn 0: UNREDACTED SECRET/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("benchmark --replay substitutes live agent with cassette at zero cost ($0)", () => {
  const repoDir = createGitRepo("bench-replay-");
  try {
    mkdirSync(join(repoDir, "bench", "cassettes"), { recursive: true });
    const prompt = "Generate answer artifact in verdict.txt";
    const tasksFile = join(repoDir, "bench", "tasks.json");
    const cassetteFile = join(repoDir, "bench", "cassettes", "task-r03.json");
    writeFileSync(
      tasksFile,
      JSON.stringify(
        {
          version: 1,
          tasks: [
            {
              id: "task-r03",
              tier: "safety",
              prompt,
              checks: [
                "node -e \"const fs=require('fs'); if(fs.readFileSync('verdict.txt','utf8').trim()!=='OK') process.exit(1);\"",
              ],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    recordCassette({
      taskId: "task-r03",
      prompt,
      response: "OK",
      files: {
        "verdict.txt": "OK\n",
      },
      out: cassetteFile,
      model: "replay-arm",
    });

    const results = runBenchmark({
      root: repoDir,
      taskId: "task-r03",
      arm: "candidate",
      cmd: "exit 99", // If live command were run, it would fail
      replay: cassetteFile,
      runs: 1,
      yes: true,
    });

    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.status, "ok");
    assert.equal(r.agentExit, 0);
    assert.equal(r.cost?.total_usd, 0, "replay runs must have cost 0");
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0].passed, true, "checks must pass on replayed output");

    // Replay drift in benchmark fails loudly: rewrite tasks.json with changed prompt
    writeFileSync(
      tasksFile,
      JSON.stringify(
        {
          version: 1,
          tasks: [
            {
              id: "task-r03",
              tier: "safety",
              prompt: "Drifted prompt that does not match cassette",
              checks: [],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );
    assert.throws(
      () =>
        runBenchmark({
          root: repoDir,
          taskId: "task-r03",
          arm: "candidate",
          cmd: "exit 99",
          replay: cassetteFile,
          runs: 1,
          yes: true,
        }),
      /lm-replay: STALE prompt drift/
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("replay prompt with secret hits cleanly without false STALE", () => {
  const tmpDir = createTempDir("lm-replay-secret-hit-");
  try {
    const cassetteFile = join(tmpDir, "cassette.json");
    const rawPrompt = 'Task prompt using api_key: "sk-live-secret-token-123456789"';
    const responseText = "Task response content";

    recordCassette({
      prompt: rawPrompt,
      response: responseText,
      out: cassetteFile,
      model: "test-model",
    });

    const res = replayCassette(cassetteFile, rawPrompt, { strict: true });
    assert.equal(res.hit, true);
    assert.equal(res.response, responseText);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("verify catches unredacted secrets in turn files and names file", () => {
  const tmpDir = createTempDir("lm-replay-verify-files-");
  try {
    const leakFile = join(tmpDir, "leak-files.json");
    const cassette = {
      version: 1,
      model: "test-model",
      recordedAt: new Date().toISOString(),
      turns: [
        {
          promptHash: hashRecordedPrompt("Clean prompt"),
          prompt: "Clean prompt",
          response: "Clean response",
          files: {
            "src/secret-config.json": '{"api_key": "sk-unredacted-in-file-123456789"}',
          },
        },
      ],
    };
    writeFileSync(leakFile, JSON.stringify(cassette, null, 2), "utf8");

    const exitCode = verifyCassette(leakFile);
    assert.equal(exitCode, 1, "cassette with secret in files must fail verify");

    const cliRes = spawnSync(process.execPath, [CLI_PATH, "verify", "--cassette", leakFile], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cliRes.status, 1);
    assert.match(cliRes.stdout + cliRes.stderr, /turn 0: UNREDACTED SECRET in files\[src\/secret-config\.json\]/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
