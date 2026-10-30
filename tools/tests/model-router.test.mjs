/**
 * tools/tests/model-router.test.mjs
 *
 * Unit and integration tests for tools/model-router.mjs per interfaces.md §T1:
 * - resolveCategory: walk chain, skip unavailable, throw MODEL_STOP_QUESTION on empty/exhausted
 * - classifyModel: heuristic /flash|mini|lite|haiku/i -> scout, reasoning|opus|pro|max -> strict, builder
 * - scanProviders: probeProvider per provider -> JSON {provider: [ids] | error}
 * - planCategories: heuristic -> categories with chain [primary, ...rest] and canonical efforts
 * - CLI --help: exit 0
 * - CLI --apply without --yes: refuses, exits non-zero, models.yml byte-identical
 * - CLI --apply with --yes: writes categories, map-form preserved
 *
 * Fixtures only, zero network calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import yaml from "yaml";
import {
  MODEL_STOP_QUESTION,
  ModelStopQuestionError,
  ROLE_TO_CATEGORY,
  DEFAULT_EFFORTS,
  classifyModel,
  resolveCategory,
  scanProviders,
  planCategories,
  applyCategories,
} from "../model-router.mjs";

const CLI_PATH = resolve(import.meta.dirname, "../model-router.mjs");

function createTempDir(prefix = "model-router-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("exports: ModelStopQuestionError, ROLE_TO_CATEGORY, and DEFAULT_EFFORTS", () => {
  const err = new ModelStopQuestionError();
  assert.equal(err.code, MODEL_STOP_QUESTION);
  assert.equal(ROLE_TO_CATEGORY.oracle, "strict");
  assert.equal(ROLE_TO_CATEGORY.fixer, "builder");
  assert.equal(ROLE_TO_CATEGORY.scout, "scout");
  assert.equal(DEFAULT_EFFORTS.strict, "high");
  assert.equal(DEFAULT_EFFORTS.builder, "medium");
  assert.equal(DEFAULT_EFFORTS.scout, "low");
});

test("classifyModel: applies heuristic correctly", () => {
  // Scout heuristic: /flash|mini|lite|haiku/i
  assert.equal(classifyModel("gemini-1.5-flash"), "scout");
  assert.equal(classifyModel("gpt-4o-mini"), "scout");
  assert.equal(classifyModel("claude-3-5-haiku-20241022"), "scout");
  assert.equal(classifyModel("qwen-2.5-lite-7b"), "scout");

  // Strict heuristic: reasoning flag or /opus|pro|max/i
  assert.equal(classifyModel("claude-3-opus"), "strict");
  assert.equal(classifyModel("gemini-1.5-pro"), "strict");
  assert.equal(classifyModel("gpt-4-max"), "strict");
  assert.equal(classifyModel("deepseek-reasoner", { reasoning: true }), "strict");
  assert.equal(classifyModel("o1-preview", { reasoning: true }), "strict");

  // Default heuristic: builder
  assert.equal(classifyModel("gpt-4o"), "builder");
  assert.equal(classifyModel("claude-3-5-sonnet"), "builder");
  assert.equal(classifyModel("llama-3.1-70b"), "builder");
});

test("resolveCategory: resolves primary model and respects role mappings", () => {
  const modelsYml = {
    categories: {
      strict: {
        chain: ["my-provider/o1", "my-provider/gpt-4o"],
        effort: "high",
      },
      builder: {
        chain: ["my-provider/gpt-4o"],
        effort: "medium",
      },
      scout: {
        chain: ["my-provider/gpt-4o-mini"],
        effort: "low",
      },
    },
  };

  const strictRes = resolveCategory("strict", modelsYml);
  assert.deepEqual(strictRes, {
    provider: "my-provider",
    model: "o1",
    effort: "high",
  });

  // Roles mapped to strict
  assert.deepEqual(resolveCategory("oracle", modelsYml), {
    provider: "my-provider",
    model: "o1",
    effort: "high",
  });
  assert.deepEqual(resolveCategory("reviewer", modelsYml), {
    provider: "my-provider",
    model: "o1",
    effort: "high",
  });

  // Roles mapped to builder
  assert.deepEqual(resolveCategory("fixer", modelsYml), {
    provider: "my-provider",
    model: "gpt-4o",
    effort: "medium",
  });

  // Roles mapped to scout
  assert.deepEqual(resolveCategory("scout", modelsYml), {
    provider: "my-provider",
    model: "gpt-4o-mini",
    effort: "low",
  });
  assert.deepEqual(resolveCategory("sonic", modelsYml), {
    provider: "my-provider",
    model: "gpt-4o-mini",
    effort: "low",
  });
});

test("resolveCategory: walks chain, skips unavailable models, stops on exhaustion without silent substitution", () => {
  const modelsYml = {
    categories: {
      strict: {
        chain: ["prov-a/o1", "prov-a/claude-opus", "prov-b/backup-max"],
        effort: "high",
      },
    },
  };

  // Skip first model if unavailable -> pick second
  const res2 = resolveCategory("strict", modelsYml, {
    unavailable: ["prov-a/o1"],
  });
  assert.deepEqual(res2, {
    provider: "prov-a",
    model: "claude-opus",
    effort: "high",
  });

  // Skip first two if unavailable -> pick third
  const res3 = resolveCategory("strict", modelsYml, {
    unavailable: ["prov-a/o1", "prov-a/claude-opus"],
  });
  assert.deepEqual(res3, {
    provider: "prov-b",
    model: "backup-max",
    effort: "high",
  });

  // When every model in chain is unavailable -> throw MODEL_STOP_QUESTION (no silent substitution)
  assert.throws(
    () => {
      resolveCategory("strict", modelsYml, {
        unavailable: ["prov-a/o1", "prov-a/claude-opus", "prov-b/backup-max"],
      });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, MODEL_STOP_QUESTION);
      assert.match(err.message, /MODEL_STOP_QUESTION/);
      return true;
    }
  );
});

test("resolveCategory: throws MODEL_STOP_QUESTION on empty chain or missing category", () => {
  const emptyConfig = {
    categories: {
      strict: { chain: [], effort: "high" },
    },
  };

  assert.throws(
    () => resolveCategory("strict", emptyConfig),
    (err) => err.code === MODEL_STOP_QUESTION
  );

  assert.throws(
    () => resolveCategory("builder", emptyConfig),
    (err) => err.code === MODEL_STOP_QUESTION
  );

  assert.throws(
    () => resolveCategory("scout", {}),
    (err) => err.code === MODEL_STOP_QUESTION
  );
});

test("scanProviders: returns JSON {provider: [ids] | error} using mock probe runner", async () => {
  const sampleModels = {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
      },
      anthropic: {
        baseUrl: "https://api.anthropic.com/v1",
      },
      local: {
        // no baseUrl
      },
    },
  };

  const mockProbe = async (prov) => {
    if (prov.name === "openai") {
      return { models: ["gpt-4o", "gpt-4o-mini", "o1"], error: null };
    }
    if (prov.name === "anthropic") {
      return { models: [], error: "HTTP 500 Internal Server Error" };
    }
    return { models: [], error: "Missing baseUrl" };
  };

  const results = await scanProviders(sampleModels, { probeRunner: mockProbe });
  assert.deepEqual(results, {
    openai: ["gpt-4o", "gpt-4o-mini", "o1"],
    anthropic: "HTTP 500 Internal Server Error",
    local: "Missing baseUrl",
  });
});

test("planCategories: heuristic assigns primary and builds chain [primary, ...rest] with canonical efforts", async () => {
  const sampleModels = {
    providers: {
      myprov: {
        models: [
          { id: "gpt-4o", reasoning: false },
          { id: "claude-3-opus", reasoning: false },
          { id: "gpt-4o-mini", reasoning: false },
        ],
      },
    },
  };

  const plan = await planCategories(sampleModels);

  // Strict: primary should be claude-3-opus, rest should include gpt-4o, gpt-4o-mini
  assert.equal(plan.strict.effort, "high");
  assert.equal(plan.strict.chain[0], "myprov/claude-3-opus");
  assert.ok(plan.strict.chain.includes("myprov/gpt-4o"));
  assert.ok(plan.strict.chain.includes("myprov/gpt-4o-mini"));

  // Builder: primary should be gpt-4o
  assert.equal(plan.builder.effort, "medium");
  assert.equal(plan.builder.chain[0], "myprov/gpt-4o");
  assert.ok(plan.builder.chain.includes("myprov/claude-3-opus"));
  assert.ok(plan.builder.chain.includes("myprov/gpt-4o-mini"));

  // Scout: primary should be gpt-4o-mini
  assert.equal(plan.scout.effort, "low");
  assert.equal(plan.scout.chain[0], "myprov/gpt-4o-mini");
  assert.ok(plan.scout.chain.includes("myprov/claude-3-opus"));
  assert.ok(plan.scout.chain.includes("myprov/gpt-4o"));
});

test("planCategories: works with probe results fixture", async () => {
  const sampleModels = {
    providers: {
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
      },
    },
  };

  const probeResults = {
    openrouter: [
      "openai/gpt-4o",
      "openai/o1-mini",
      "anthropic/claude-3-opus",
      "google/gemini-flash-1.5",
    ],
  };

  const plan = await planCategories(sampleModels, { probeResults });

  // Strict primary: anthropic/claude-3-opus
  assert.equal(plan.strict.chain[0], "openrouter/anthropic/claude-3-opus");
  assert.equal(plan.strict.effort, "high");

  // Builder primary: openai/gpt-4o
  assert.equal(plan.builder.chain[0], "openrouter/openai/gpt-4o");
  assert.equal(plan.builder.effort, "medium");

  // Scout primary: openai/o1-mini or google/gemini-flash-1.5
  assert.ok(
    plan.scout.chain[0] === "openrouter/openai/o1-mini" ||
    plan.scout.chain[0] === "openrouter/google/gemini-flash-1.5"
  );
  assert.equal(plan.scout.effort, "low");
});

test("CLI: --help exits 0 and displays options", () => {
  const proc = spawnSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8" });
  assert.equal(proc.status, 0);
  assert.match(proc.stdout, /--scan/);
  assert.match(proc.stdout, /--plan/);
  assert.match(proc.stdout, /--apply/);
  assert.match(proc.stdout, /--yes/);
});

test("CLI: --plan prints plan without writing to models.yml (file byte-identical)", () => {
  const tmp = createTempDir();
  try {
    const modelsPath = join(tmp, "models.yml");
    const initialContent = `# Original Header Comment\nproviders:\n  demo:\n    baseUrl: https://api.demo.com/v1\n    models:\n      - id: gpt-4o\n      - id: gpt-4o-mini\n      - id: claude-3-opus\n`;
    writeFileSync(modelsPath, initialContent, "utf8");

    const beforeBytes = readFileSync(modelsPath);

    const proc = spawnSync(
      process.execPath,
      [CLI_PATH, "--plan", "--models", modelsPath],
      { encoding: "utf8" }
    );

    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /categories:/);
    assert.match(proc.stdout, /strict:/);
    assert.match(proc.stdout, /builder:/);
    assert.match(proc.stdout, /scout:/);

    // Assert file is strictly byte-identical
    const afterBytes = readFileSync(modelsPath);
    assert.deepEqual(beforeBytes, afterBytes, "models.yml must remain byte-identical after --plan");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: --apply without --yes refuses and leaves models.yml byte-identical", () => {
  const tmp = createTempDir();
  try {
    const modelsPath = join(tmp, "models.yml");
    const initialContent = `# Operator Config\nproviders:\n  prod:\n    baseUrl: https://api.prod.com/v1\n    apiKey: secret-token\n    models:\n      - id: gpt-4o\n`;
    writeFileSync(modelsPath, initialContent, "utf8");

    const beforeBytes = readFileSync(modelsPath);

    const proc = spawnSync(
      process.execPath,
      [CLI_PATH, "--apply", "--models", modelsPath],
      { encoding: "utf8" }
    );

    // Refusal: non-zero exit code
    assert.notEqual(proc.status, 0, "CLI must refuse --apply without --yes");
    assert.match(proc.stderr, /Refused: --apply requires --yes/);

    // Critical invariant: models.yml must remain strictly byte-identical
    const afterBytes = readFileSync(modelsPath);
    assert.deepEqual(beforeBytes, afterBytes, "models.yml must remain byte-identical when --apply has no --yes");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: --apply with --yes writes categories and preserves comments and map-form", () => {
  const tmp = createTempDir();
  try {
    const modelsPath = join(tmp, "models.yml");
    const initialContent = `# Main config comment\nproviders:\n  prod:\n    baseUrl: https://api.prod.com/v1\n    models:\n      - id: gpt-4o\n      - id: claude-3-opus\n      - id: gpt-4o-mini\n`;
    writeFileSync(modelsPath, initialContent, "utf8");

    const proc = spawnSync(
      process.execPath,
      [CLI_PATH, "--apply", "--yes", "--models", modelsPath],
      { encoding: "utf8" }
    );

    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /Successfully applied categories/);

    const writtenContent = readFileSync(modelsPath, "utf8");
    assert.ok(writtenContent.includes("# Main config comment"), "Preserves existing comments");
    assert.ok(writtenContent.includes("providers:\n  prod:"), "Preserves map-form providers");

    const parsed = yaml.parse(writtenContent);
    assert.ok(parsed.categories, "categories section created");
    assert.equal(parsed.categories.strict.effort, "high");
    assert.equal(parsed.categories.builder.effort, "medium");
    assert.equal(parsed.categories.scout.effort, "low");

    // resolveCategory on written file
    const resolvedStrict = resolveCategory("strict", modelsPath);
    assert.equal(resolvedStrict.provider, "prod");
    assert.equal(resolvedStrict.model, "claude-3-opus");
    assert.equal(resolvedStrict.effort, "high");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyCategories programmatic: refuses without yes, writes with yes", async () => {
  const tmp = createTempDir();
  try {
    const modelsPath = join(tmp, "models.yml");
    const initialContent = `providers:\n  demo:\n    models:\n      - id: default-model\n`;
    writeFileSync(modelsPath, initialContent, "utf8");

    const beforeBytes = readFileSync(modelsPath);

    // Refusal without yes
    await assert.rejects(
      () => applyCategories(modelsPath, { yes: false }),
      /Refused: --apply requires --yes/
    );

    assert.deepEqual(beforeBytes, readFileSync(modelsPath), "File unchanged on refusal");

    // Success with yes
    const res = await applyCategories(modelsPath, {
      yes: true,
      plan: {
        strict: { chain: ["demo/default-model"], effort: "high" },
        builder: { chain: ["demo/default-model"], effort: "medium" },
        scout: { chain: ["demo/default-model"], effort: "low" },
      },
    });

    assert.equal(res.ok, true);
    const parsed = yaml.parse(readFileSync(modelsPath, "utf8"));
    assert.deepEqual(parsed.categories.strict.chain, ["demo/default-model"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: --scan with nonexistent models path fails loudly with exit 2", () => {
  const nonexistentPath = join(tmpdir(), "nonexistent-models-never-exists.yml");
  const proc = spawnSync(
    process.execPath,
    [CLI_PATH, "--scan", "--models", nonexistentPath],
    { encoding: "utf8" }
  );

  assert.equal(proc.status, 2, "Must exit with status 2 on nonexistent models file");
  assert.match(proc.stderr, /models file not found/i);
});
