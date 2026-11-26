import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTempDir } from "./test-helpers.mjs";
import { loadPack, hashFileSha256 } from "../pack-format.mjs";

function makePackFixture({ name = "fixture-pack", version = "1.0.0", targets = ["claude"], files = {}, tests = "tests/test.mjs", testsContent = "process.exit(0);\n" } = {}) {
  const dir = createTempDir("pack-format-test-");
  const modulesDir = join(dir, "modules");
  mkdirSync(modulesDir, { recursive: true });

  const manifestFiles = [];
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(modulesDir, relPath);
    mkdirSync(join(modulesDir, relPath, ".."), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
    const sha256 = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
    manifestFiles.push({ path: relPath, sha256 });
  }

  if (tests) {
    const testFullPath = join(dir, tests);
    mkdirSync(join(dir, tests, ".."), { recursive: true });
    writeFileSync(testFullPath, testsContent, "utf8");
  }

  const manifest = {
    name,
    version,
    targets,
    files: manifestFiles,
    tests,
  };

  writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dir, manifest, manifestFiles };
}

test("loadPack: loads valid pack and verifies hashes correctly", () => {
  const { dir } = makePackFixture({
    files: {
      "index.mjs": "export const foo = 42;\n",
      "lib/util.mjs": "export function util() { return true; }\n",
    },
  });

  try {
    const pack = loadPack(dir);
    assert.equal(pack.manifest.name, "fixture-pack");
    assert.equal(pack.manifest.version, "1.0.0");
    assert.equal(pack.files.length, 2);
    const indexFile = pack.files.find((f) => f.path === "index.mjs");
    assert.ok(indexFile);
    assert.equal(indexFile.sha256, hashFileSha256(indexFile.fullPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPack: refuses pack when modules/ contains an unlisted file", () => {
  const { dir } = makePackFixture({
    files: { "allowed.mjs": "console.log('ok');\n" },
  });

  try {
    writeFileSync(join(dir, "modules", "intruder.mjs"), "malicious code;\n", "utf8");
    assert.throws(
      () => loadPack(dir),
      /workflow pack: unlisted file in modules\/: intruder\.mjs/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPack: refuses pack when manifest lists file missing from modules/", () => {
  const { dir, manifest } = makePackFixture({
    files: { "present.mjs": "ok\n" },
  });

  try {
    manifest.files.push({
      path: "ghost.mjs",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest, null, 2), "utf8");
    assert.throws(
      () => loadPack(dir),
      /workflow pack: listed file missing from modules\/: ghost\.mjs/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPack: refuses pack when file hash does not match manifest", () => {
  const { dir } = makePackFixture({
    files: { "tampered.mjs": "original content\n" },
  });

  try {
    writeFileSync(join(dir, "modules", "tampered.mjs"), "altered content\n", "utf8");
    assert.throws(
      () => loadPack(dir),
      /workflow pack: hash mismatch for tampered\.mjs/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPack: refuses corrupt pack.json or missing required fields", () => {
  const dir = createTempDir("pack-format-corrupt-");
  try {
    writeFileSync(join(dir, "pack.json"), "{ invalid json", "utf8");
    assert.throws(() => loadPack(dir), /workflow pack: invalid pack\.json/);

    writeFileSync(join(dir, "pack.json"), JSON.stringify({ version: "1.0.0", targets: ["claude"], files: [], tests: "t.js" }), "utf8");
    assert.throws(() => loadPack(dir), /workflow pack: pack\.json missing or invalid 'name'/);

    writeFileSync(join(dir, "pack.json"), JSON.stringify({ name: "p", targets: ["claude"], files: [], tests: "t.js" }), "utf8");
    assert.throws(() => loadPack(dir), /workflow pack: pack\.json missing or invalid 'version'/);

    writeFileSync(join(dir, "pack.json"), JSON.stringify({ name: "p", version: "1.0.0", targets: [], files: [], tests: "t.js" }), "utf8");
    assert.throws(() => loadPack(dir), /workflow pack: pack\.json missing or invalid 'targets'/);

    writeFileSync(join(dir, "pack.json"), JSON.stringify({ name: "p", version: "1.0.0", targets: ["claude"], files: "not-an-array", tests: "t.js" }), "utf8");
    assert.throws(() => loadPack(dir), /workflow pack: pack\.json missing or invalid 'files'/);

    writeFileSync(join(dir, "pack.json"), JSON.stringify({ name: "p", version: "1.0.0", targets: ["claude"], files: [] }), "utf8");
    assert.throws(() => loadPack(dir), /workflow pack: pack\.json missing or invalid 'tests' entrypoint/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPack: refuses path traversal in files list", () => {
  const dir = createTempDir("pack-format-traversal-");
  try {
    const manifest = {
      name: "traversal-pack",
      version: "1.0.0",
      targets: ["claude"],
      files: [
        { path: "../outside.mjs", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
      ],
      tests: "tests/test.mjs",
    };
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "test.mjs"), "process.exit(0);\n", "utf8");
    writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest), "utf8");

    assert.throws(
      () => loadPack(dir),
      /workflow pack: file path contains invalid path traversal/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPack: refuses missing or escaping tests entrypoint", () => {
  const dir = createTempDir("pack-format-test-entry-");
  try {
    const manifest = {
      name: "missing-tests-pack",
      version: "1.0.0",
      targets: ["claude"],
      files: [],
      tests: "tests/does-not-exist.mjs",
    };
    writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest), "utf8");
    assert.throws(
      () => loadPack(dir),
      /workflow pack: tests entrypoint not found/
    );

    manifest.tests = "../escaping-test.mjs";
    writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest), "utf8");
    assert.throws(
      () => loadPack(dir),
      /workflow pack: tests entrypoint escapes pack root/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
