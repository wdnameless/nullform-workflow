import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createTempDir } from "./test-helpers.mjs";
import {
  diagnoseManifests,
  diagnoseRequirements,
  diagnosePyproject,
  diagnosePackageJson,
  parseRequirementLine,
  normalizePackageName,
  PYTHON_STDLIB_MODULES,
  NODE_BUILTIN_MODULES,
  OBSOLETE_BACKPORTS,
  DISCLAIMER,
} from "../dependency-doctor.mjs";

const CLI_PATH = join(fileURLToPath(new URL(".", import.meta.url)), "../dependency-doctor.mjs");

describe("Dependency Doctor Unit Functions", () => {
  it("normalizes package names per PEP 503 and npm", () => {
    assert.equal(normalizePackageName("Flask"), "flask");
    assert.equal(normalizePackageName("importlib_metadata"), "importlib-metadata");
    assert.equal(normalizePackageName("importlib.metadata"), "importlib-metadata");
    assert.equal(normalizePackageName("foo---bar.._baz"), "foo-bar-baz");
  });

  it("parses requirement lines with versions, markers, comments", () => {
    assert.deepEqual(parseRequirementLine("requests==2.28.0"), {
      name: "requests",
      normalized: "requests",
      spec: "==2.28.0",
      exactVersion: "2.28.0",
      unpinned: false,
      raw: "requests==2.28.0",
    });

    assert.deepEqual(parseRequirementLine("flask"), {
      name: "flask",
      normalized: "flask",
      spec: "",
      exactVersion: null,
      unpinned: true,
      raw: "flask",
    });

    assert.equal(parseRequirementLine("# just a comment"), null);
    assert.equal(parseRequirementLine("-r requirements-dev.txt"), null);
    assert.equal(parseRequirementLine("--index-url https://pypi.org"), null);
    assert.equal(parseRequirementLine("   "), null);
  });
});

describe("Category 1: stdlib shadowing", () => {
  it("flags python stdlib modules in requirements.txt", () => {
    const content = [
      "requests==2.28.0",
      "math==1.0",
      "json",
      "random>=1.2",
    ].join("\n");

    const res = diagnoseRequirements(content, "requirements.txt");
    const shadowFindings = res.findings.filter((f) => f.category === "stdlib-shadowing");
    assert.equal(shadowFindings.length, 3);
    const names = shadowFindings.map((f) => f.dependency).sort();
    assert.deepEqual(names, ["json", "math", "random"]);
    assert.match(shadowFindings[0].message, /shadows.*standard library/i);
  });

  it("flags node builtin modules in package.json", () => {
    const pkg = {
      name: "sample-app",
      version: "1.0.0",
      dependencies: {
        express: "^4.18.2",
        fs: "^0.0.1-security",
        path: "^0.12.7",
      },
      devDependencies: {
        crypto: "^1.0.1",
      },
    };

    const res = diagnosePackageJson(pkg, "package.json");
    const shadowFindings = res.findings.filter((f) => f.category === "stdlib-shadowing");
    assert.equal(shadowFindings.length, 3);
    const names = shadowFindings.map((f) => f.dependency).sort();
    assert.deepEqual(names, ["crypto", "fs", "path"]);
  });
});

describe("Category 2: obsolete backports", () => {
  it("flags obsolete python backports", () => {
    const content = [
      "typing==3.7.4.3",
      "dataclasses==0.6",
      "pathlib2==2.3.7",
      "importlib-metadata==6.0.0",
      "mock==5.0.0",
    ].join("\n");

    const res = diagnoseRequirements(content, "requirements.txt");
    const backports = res.findings.filter((f) => f.category === "obsolete-backport");
    assert.equal(backports.length, 5);
    const names = backports.map((f) => f.dependency).sort();
    assert.deepEqual(names, ["dataclasses", "importlib-metadata", "mock", "pathlib2", "typing"]);
  });

  it("flags obsolete node backports in package.json", () => {
    const pkg = {
      dependencies: {
        "node-fetch": "^2.6.7",
        "abort-controller": "^3.0.0",
        "util.promisify": "^1.1.1",
      },
    };

    const res = diagnosePackageJson(pkg, "package.json");
    const backports = res.findings.filter((f) => f.category === "obsolete-backport");
    assert.equal(backports.length, 3);
    const names = backports.map((f) => f.dependency).sort();
    assert.deepEqual(names, ["abort-controller", "node-fetch", "util.promisify"]);
  });
});

describe("Category 3: unpinned dependencies", () => {
  it("flags bare and wildcard python dependencies", () => {
    const content = [
      "requests",
      "flask*",
      "gunicorn>=0",
      "numpy==1.24.0",
    ].join("\n");

    const res = diagnoseRequirements(content, "requirements.txt");
    const unpinned = res.findings.filter((f) => f.category === "unpinned");
    assert.equal(unpinned.length, 3);
    const names = unpinned.map((f) => f.dependency).sort();
    assert.deepEqual(names, ["flask*", "gunicorn>=0", "requests"]);
  });

  it("flags unpinned npm dependencies in package.json (*, latest, empty)", () => {
    const pkg = {
      dependencies: {
        express: "*",
        cors: "latest",
        lodash: "",
        dotenv: "^16.0.0",
      },
    };

    const res = diagnosePackageJson(pkg, "package.json");
    const unpinned = res.findings.filter((f) => f.category === "unpinned");
    assert.equal(unpinned.length, 3);
    const names = unpinned.map((f) => f.dependency).sort();
    assert.deepEqual(names, ["cors", "express", "lodash"]);
  });
});

describe("Category 4: duplicates", () => {
  it("flags repeated declarations in requirements.txt (including case/dash normalization)", () => {
    const content = [
      "requests==2.28.0",
      "Flask==2.0.1",
      "requests==2.28.0",
      "flask==2.0.1",
      "importlib-metadata==4.0.0",
      "importlib_metadata==4.0.0",
    ].join("\n");

    const res = diagnoseRequirements(content, "requirements.txt");
    const dupes = res.findings.filter((f) => f.category === "duplicate");
    assert.ok(dupes.length >= 3, `Expected at least 3 duplicates, got ${dupes.length}`);
    const deps = dupes.map((f) => f.dependency.toLowerCase());
    assert.ok(deps.some((d) => d.includes("requests")));
    assert.ok(deps.some((d) => d.includes("flask")));
    assert.ok(deps.some((d) => d.includes("importlib")));
  });

  it("flags duplicates between dependencies and devDependencies in package.json", () => {
    const pkg = {
      dependencies: {
        lodash: "^4.17.21",
        chalk: "^5.0.0",
      },
      devDependencies: {
        lodash: "^4.17.21",
        jest: "^29.0.0",
      },
    };

    const res = diagnosePackageJson(pkg, "package.json");
    const dupes = res.findings.filter((f) => f.category === "duplicate");
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0].dependency, "lodash");
  });
});

describe("Category 5: exact conflicts", () => {
  it("flags conflicting exact pins in requirements.txt", () => {
    const content = [
      "requests==2.28.0",
      "urllib3==1.26.15",
      "requests==2.31.0",
    ].join("\n");

    const res = diagnoseRequirements(content, "requirements.txt");
    const conflicts = res.findings.filter((f) => f.category === "exact-conflict");
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].dependency, "requests");
    assert.match(conflicts[0].message, /conflict/i);
  });

  it("flags conflicting exact pins between dependencies and devDependencies in package.json", () => {
    const pkg = {
      dependencies: {
        react: "18.2.0",
      },
      devDependencies: {
        react: "17.0.2",
      },
    };

    const res = diagnosePackageJson(pkg, "package.json");
    const conflicts = res.findings.filter((f) => f.category === "exact-conflict");
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].dependency, "react");
  });
});

describe("pyproject.toml manifest diagnosis", () => {
  it("diagnoses PEP 621 dependencies array and optional-dependencies", () => {
    const content = `
[project]
name = "my-project"
version = "0.1.0"
dependencies = [
    "requests==2.28.0",
    "math",
    "dataclasses>=0.6",
    "flask",
    "requests==2.31.0"
]

[project.optional-dependencies]
dev = [
    "pytest>=7.0.0",
    "typing"
]
`;

    const res = diagnosePyproject(content, "pyproject.toml");
    const catMap = res.findings.reduce((acc, f) => {
      acc[f.category] = (acc[f.category] || 0) + 1;
      return acc;
    }, {});

    assert.ok(catMap["stdlib-shadowing"] >= 1, "math should be flagged as stdlib");
    assert.ok(catMap["obsolete-backport"] >= 2, "dataclasses and typing should be flagged");
    assert.ok(catMap["unpinned"] >= 2, "math and flask unpinned");
    assert.ok(catMap["exact-conflict"] >= 1, "requests 2.28.0 vs 2.31.0 conflict");
  });

  it("diagnoses Poetry [tool.poetry.dependencies]", () => {
    const content = `
[tool.poetry]
name = "poetry-app"
version = "1.0.0"

[tool.poetry.dependencies]
python = "^3.10"
requests = "*"
json = "2.0.9"
mock = "^4.0.0"
`;

    const res = diagnosePyproject(content, "pyproject.toml");
    const cats = res.findings.map((f) => f.category);
    assert.ok(cats.includes("unpinned"), "requests = * is unpinned");
    assert.ok(cats.includes("stdlib-shadowing"), "json shadows stdlib");
    assert.ok(cats.includes("obsolete-backport"), "mock is obsolete backport");
  });
});

describe("Safety, Offline & Non-CVE Invariants", () => {
  it("guarantees no file modification on disk (read-only audit)", () => {
    const dir = createTempDir("dep-doc-safe-");
    try {
      const reqPath = join(dir, "requirements.txt");
      const initialReq = "requests==2.28.0\nmath\n";
      writeFileSync(reqPath, initialReq, "utf8");

      const pkgPath = join(dir, "package.json");
      const initialPkg = JSON.stringify({ dependencies: { fs: "*" } }, null, 2);
      writeFileSync(pkgPath, initialPkg, "utf8");

      const report = diagnoseManifests({ root: dir });
      assert.ok(report.findings.length > 0);

      const afterReq = readFileSync(reqPath, "utf8");
      const afterPkg = readFileSync(pkgPath, "utf8");

      assert.equal(afterReq, initialReq, "requirements.txt was mutated by doctor!");
      assert.equal(afterPkg, initialPkg, "package.json was mutated by doctor!");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes explicit disclaimer rejecting CVE completeness claims", () => {
    assert.match(DISCLAIMER, /cve/i);
    assert.match(DISCLAIMER, /vulnerability/i);
    assert.match(DISCLAIMER, /offline/i);

    const report = diagnoseManifests({ root: createTempDir("empty-") });
    assert.equal(report.disclaimer, DISCLAIMER);
  });
});

describe("CLI Integration", () => {
  it("outputs JSON with --json", () => {
    const dir = createTempDir("cli-test-");
    try {
      writeFileSync(join(dir, "requirements.txt"), "math\n", "utf8");
      const run = spawnSync(process.execPath, [CLI_PATH, "--root", dir, "--json"], {
        encoding: "utf8",
      });
      assert.equal(run.status, 0);
      const parsed = JSON.parse(run.stdout);
      assert.equal(typeof parsed.ok, "boolean");
      assert.ok(Array.isArray(parsed.findings));
      assert.equal(parsed.disclaimer, DISCLAIMER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 on issues with --check", () => {
    const dir = createTempDir("cli-check-");
    try {
      writeFileSync(join(dir, "requirements.txt"), "requests==2.28.0\nrequests==2.31.0\n", "utf8");
      const run = spawnSync(process.execPath, [CLI_PATH, "--root", dir, "--check"], {
        encoding: "utf8",
      });
      assert.equal(run.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 with --check on clean manifests", () => {
    const dir = createTempDir("cli-clean-");
    try {
      writeFileSync(join(dir, "requirements.txt"), "requests==2.31.0\nclick==8.1.7\n", "utf8");
      const run = spawnSync(process.execPath, [CLI_PATH, "--root", dir, "--check"], {
        encoding: "utf8",
      });
      assert.equal(run.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
