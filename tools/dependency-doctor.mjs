#!/usr/bin/env node
/**
 * tools/dependency-doctor.mjs — offline dependency manifest diagnosis.
 *
 * Implements R10:
 *   - Offline manifest diagnosis for requirements.txt, pyproject.toml, package.json
 *   - Diagnostic categories:
 *       1. stdlib shadowing (e.g. third-party dependencies shadowing Python or Node built-ins)
 *       2. obsolete backports (e.g. typing, dataclasses, importlib-metadata, node-fetch)
 *       3. unpinned dependencies (missing version constraints or wildcards)
 *       4. duplicates (multiple declarations of the same dependency)
 *       5. exact conflicts (incompatible exact version pins for the same dependency)
 *   - Safety invariants:
 *       - Read-only: NEVER mutates or auto-edits manifest files
 *       - Offline: ZERO network requests, deterministic static catalogs
 *       - Honest boundaries: explicitly disclaims CVE completeness or vulnerability coverage
 *
 * Exit codes:
 *   0 — Clean (no actionable errors/warnings found with --check)
 *   1 — Actionable issues detected with --check
 *   2 — Usage error or manifest target unreadable
 *
 * Zero dependencies. Node 18+ / Bun.
 */

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

export const DISCLAIMER =
  "This tool performs offline dependency manifest diagnosis (stdlib shadowing, obsolete backports, unpinned dependencies, duplicates, exact conflicts). It does NOT perform CVE or vulnerability database lookups and makes no claim of CVE coverage or security completeness.";

export const PYTHON_STDLIB_MODULES = new Set([
  "abc", "aifc", "antigravity", "argparse", "array", "ast", "asynchat", "asyncio",
  "asyncore", "atexit", "audioop", "base64", "bdb", "binascii", "binhex", "bisect",
  "builtins", "bz2", "cProfile", "calendar", "cgi", "cgitb", "chunk", "cmath", "cmd",
  "code", "codecs", "codeop", "collections", "colorsys", "compileall", "concurrent",
  "configparser", "contextlib", "contextvars", "copy", "copyreg", "crypt", "csv",
  "ctypes", "curses", "dataclasses", "datetime", "dbm", "decimal", "difflib", "dis",
  "distutils", "doctest", "email", "encodings", "ensurepip", "enum", "errno", "faulthandler",
  "fcntl", "filecmp", "fileinput", "fnmatch", "formatter", "fpectl", "fractions", "ftplib",
  "functools", "gc", "getopt", "getpass", "gettext", "glob", "graphlib", "grp", "gzip",
  "hashlib", "heapq", "hmac", "html", "http", "idlelib", "imaplib", "imghdr", "imp",
  "importlib", "inspect", "io", "ipaddress", "itertools", "json", "keyword", "lib2to3",
  "linecache", "locale", "logging", "lzma", "macpath", "mailbox", "mailcap", "marshal",
  "math", "mimetypes", "mmap", "modulefinder", "msilib", "msvcrt", "multiprocessing",
  "netrc", "nis", "nntplib", "numbers", "operator", "optparse", "os", "ossaudiodev",
  "parser", "pathlib", "pdb", "pickle", "pickletools", "pipes", "pkgutil", "platform",
  "plistlib", "poplib", "posix", "posixpath", "pprint", "profile", "pstats", "pty",
  "pwd", "py_compile", "pyclbr", "pydoc", "pydoc_data", "pyexpat", "queue", "quopri",
  "random", "re", "readline", "reprlib", "resource", "rlcompleter", "runpy", "sched",
  "secrets", "select", "selectors", "shelve", "shlex", "shutil", "signal", "site",
  "smtpd", "smtplib", "sndhdr", "socket", "socketserver", "spwd", "sqlite3", "sre",
  "sre_compile", "sre_constants", "sre_parse", "ssl", "stat", "statistics", "string",
  "stringprep", "struct", "subprocess", "sunau", "symbol", "symtable", "sys",
  "sysconfig", "syslog", "tabnanny", "tarfile", "telnetlib", "tempfile", "termios",
  "test", "textwrap", "this", "threading", "time", "timeit", "tkinter", "token",
  "tokenize", "tomllib", "trace", "traceback", "tracemalloc", "tty", "turtle",
  "turtledemo", "types", "typing", "unicodedata", "unittest", "urllib", "uu", "uuid",
  "venv", "warnings", "wave", "weakref", "webbrowser", "winreg", "winsound", "wsgiref",
  "xdrlib", "xml", "xmlrpc", "zipapp", "zipfile", "zipimport", "zlib", "zoneinfo",
]);

export const NODE_BUILTIN_MODULES = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
  "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
  "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads",
  "zlib",
]);

export const OBSOLETE_BACKPORTS = {
  // Python backports
  "typing": "Standard library module built into Python 3.5+; installing backport breaks typing in modern Python",
  "dataclasses": "Standard library module built into Python 3.7+",
  "importlib-metadata": "Standard library module 'importlib.metadata' in Python 3.8+",
  "importlib-resources": "Standard library module 'importlib.resources' in Python 3.9+",
  "pathlib": "Standard library module built into Python 3.4+",
  "pathlib2": "Backport of pathlib; built into standard library since Python 3.4",
  "contextlib2": "Standard library module 'contextlib' has incorporated these features since Python 3.7",
  "mock": "Standard library module 'unittest.mock' built into Python 3.3+",
  "enum34": "Standard library module 'enum' built into Python 3.4+",
  "funcsigs": "Standard library module 'inspect.signature' built into Python 3.3+",
  "futures": "Standard library module 'concurrent.futures' built into Python 3.2+",
  "asyncio": "Standard library module built into Python 3.4+",
  "statistics": "Standard library module built into Python 3.4+",
  "simplejson": "Standard library module 'json' built into Python since 2.6",
  "argparse": "Standard library module built into Python since 2.7 / 3.2",
  "async-timeout": "Standard library module 'asyncio.timeout' in Python 3.11+",
  "exceptiongroup": "Standard library feature built into Python 3.11+",
  "tomli": "Standard library module 'tomllib' in Python 3.11+",
  "configparser": "Standard library module 'configparser' in Python 3.0+",
  // Node.js backports
  "node-fetch": "Native 'fetch' is available globally in Node.js 18+",
  "abort-controller": "Native 'AbortController' is available globally in Node.js 15+",
  "form-data": "Native 'FormData' is available globally in Node.js 18+",
  "es6-promise": "Native 'Promise' is available in ES6 / Node.js 0.12+",
  "object-assign": "Native 'Object.assign' is available in ES6 / Node.js 4+",
  "util.promisify": "Native 'util.promisify' is built into Node.js 8+",
};

/**
 * Normalizes Python package name per PEP 503 or npm package name.
 * @param {string} name
 * @returns {string}
 */
export function normalizePackageName(name) {
  if (typeof name !== "string") return "";
  const s = name.trim().toLowerCase();
  if (s.startsWith("@")) {
    const slash = s.indexOf("/");
    if (slash !== -1) {
      return `${s.slice(0, slash)}/${s.slice(slash + 1).replace(/[-_.]+/g, "-")}`;
    }
  }
  return s.replace(/[-_.]+/g, "-");
}

/**
 * Parses a single requirement line.
 * @param {string} rawLine
 * @returns {{ name: string, normalized: string, spec: string, exactVersion: string|null, unpinned: boolean, raw: string } | null}
 */
export function parseRequirementLine(rawLine) {
  if (typeof rawLine !== "string") return null;
  const stripped = rawLine.replace(/^\uFEFF/, "").trim();
  if (!stripped || stripped.startsWith("#")) return null;
  if (/^-[a-zA-Z]|^--/.test(stripped)) return null;

  // Strip trailing inline comment
  const noComment = stripped.replace(/\s+#.*$/, "").trim();
  if (!noComment) return null;

  // Split environment marker e.g. ; python_version < '3.8'
  const parts = noComment.split(";");
  const depPart = parts[0].trim();
  if (!depPart) return null;

  // Match package name and version specifier
  // Package names may include extras like requests[security]
  const match = depPart.match(/^([a-zA-Z0-9_.-]+)(?:\[[^\]]*\])?\s*(.*)$/);
  if (!match) return null;

  const rawName = match[1];
  const specPart = (match[2] || "").trim();
  const normalized = normalizePackageName(rawName);

  // Exact version e.g. ==2.28.0 or ===2.28.0
  let exactVersion = null;
  const exactMatch = specPart.match(/^={2,3}\s*([a-zA-Z0-9_.-]+)$/);
  if (exactMatch && exactMatch[1] !== "*") {
    exactVersion = exactMatch[1];
  }

  // Unpinned detection:
  // - No specifier at all (e.g. "flask")
  // - Wildcard (e.g. "flask*" or "==*" or "=*")
  // - Loose range with no upper bound e.g. ">=0" or ">=0.0.0"
  let unpinned = false;
  if (!specPart) {
    unpinned = true;
  } else if (specPart.includes("*") || /^={1,3}\s*\*$/.test(specPart)) {
    unpinned = true;
  } else if (/^>=\s*0(?:\.0)*$/.test(specPart)) {
    unpinned = true;
  }

  return {
    name: rawName,
    normalized,
    spec: specPart,
    exactVersion,
    unpinned,
    raw: stripped,
  };
}

/**
 * Shared diagnostic runner for Python dependency declarations.
 * @param {Array<{ line: number, text: string }>} rawDeclarations
 * @param {string} filePath
 * @param {string} manifestContext
 * @returns {{ ok: boolean, dependencyCount: number, findings: Array<object> }}
 */
function diagnosePythonDeclarations(rawDeclarations, filePath, manifestContext = "") {
  const findings = [];
  const entriesByNorm = new Map();
  let dependencyCount = 0;

  for (const { line, text } of rawDeclarations) {
    const parsed = parseRequirementLine(text);
    if (!parsed) continue;

    dependencyCount++;
    const { name, normalized, exactVersion, unpinned, raw } = parsed;

    if (OBSOLETE_BACKPORTS[normalized]) {
      findings.push({
        category: "obsolete-backport",
        severity: "warn",
        file: filePath,
        line,
        dependency: name,
        message: `Dependency '${name}' is an obsolete backport: ${OBSOLETE_BACKPORTS[normalized]}`,
        detail: OBSOLETE_BACKPORTS[normalized],
      });
    } else if (PYTHON_STDLIB_MODULES.has(normalized)) {
      findings.push({
        category: "stdlib-shadowing",
        severity: "warn",
        file: filePath,
        line,
        dependency: name,
        message: `Dependency '${name}' shadows Python standard library module`,
        detail: "Standard library module built into Python",
      });
    }

    if (unpinned) {
      const suffix = manifestContext ? ` in ${manifestContext}` : "";
      findings.push({
        category: "unpinned",
        severity: "warn",
        file: filePath,
        line,
        dependency: raw,
        message: `Dependency '${raw}' is unpinned${suffix}`,
        detail: "Unpinned dependency risks non-reproducible installations and unexpected breaking updates",
      });
    }

    if (!entriesByNorm.has(normalized)) {
      entriesByNorm.set(normalized, []);
    }
    entriesByNorm.get(normalized).push({ line, name, exactVersion, raw });
  }

  for (const [normName, declarations] of entriesByNorm.entries()) {
    if (declarations.length > 1) {
      const loc = declarations.map((d) => d.line).join(", ");
      const suffix = manifestContext ? ` in ${manifestContext}` : ` (lines ${loc})`;
      findings.push({
        category: "duplicate",
        severity: "warn",
        file: filePath,
        line: declarations[1].line,
        dependency: declarations[1].name,
        message: `Dependency '${declarations[1].name}' is declared multiple times${suffix}`,
        detail: `Multiple declarations found for normalized package '${normName}'`,
      });

      const exactPins = declarations.filter((d) => d.exactVersion !== null);
      const uniquePins = [...new Set(exactPins.map((d) => d.exactVersion))];
      if (uniquePins.length > 1) {
        findings.push({
          category: "exact-conflict",
          severity: "error",
          file: filePath,
          line: declarations[declarations.length - 1].line,
          dependency: declarations[declarations.length - 1].name,
          message: `Conflicting exact versions declared for '${normName}': ${uniquePins.join(" vs ")}`,
          detail: `Declarations at lines ${declarations.map((d) => `${d.line} (${d.raw})`).join(", ")}`,
        });
      }
    }
  }

  const ok = findings.length === 0;
  return { ok, dependencyCount, findings };
}

/**
 * Diagnose a requirements.txt file or string.
 * @param {string} content
 * @param {string} filePath
 * @returns {{ ok: boolean, dependencyCount: number, findings: Array<object> }}
 */
export function diagnoseRequirements(content, filePath = "requirements.txt") {
  const lines = String(content).replace(/^\uFEFF/, "").split(/\r?\n/);
  const rawDeclarations = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/^\uFEFF/, "").trim();
    if (trimmed && !trimmed.startsWith("#") && !/^-[a-zA-Z]|^--/.test(trimmed)) {
      rawDeclarations.push({ line: i + 1, text: lines[i] });
    }
  }
  return diagnosePythonDeclarations(rawDeclarations, filePath, "");
}

/**
 * Diagnose pyproject.toml content.
 * @param {string} content
 * @param {string} filePath
 * @returns {{ ok: boolean, dependencyCount: number, findings: Array<object> }}
 */
export function diagnosePyproject(content, filePath = "pyproject.toml") {
  const norm = String(content).replace(/^\uFEFF/, "");
  const lines = norm.split(/\r?\n/);
  const rawRequirements = [];

  let currentSection = "";
  let inArray = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      inArray = false;
      continue;
    }

    const isDepSection =
      currentSection === "project" ||
      currentSection.startsWith("project.optional-dependencies") ||
      currentSection === "tool.poetry.dependencies" ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(currentSection) ||
      currentSection === "tool.flit.metadata";

    if (!isDepSection) continue;

    // Inside PEP 621 array: dependencies = [ ... ] or dev = [ ... ]
    if (/^(dependencies|requires|[a-zA-Z0-9_.-]+)\s*=\s*\[/.test(trimmed)) {
      inArray = true;
      const inlineArrayMatch = trimmed.match(/=\s*\[(.*)\]/);
      if (inlineArrayMatch) {
        const items = inlineArrayMatch[1].split(",");
        for (const it of items) {
          const itemTrimmed = it.trim().replace(/^["']|["']$/g, "");
          if (itemTrimmed) rawRequirements.push({ line: lineNum, text: itemTrimmed });
        }
        inArray = false;
        continue;
      }
      continue;
    }

    if (inArray) {
      if (trimmed.includes("]")) inArray = false;
      const itemMatch = trimmed.match(/^["']([^"']+)["'],?/);
      if (itemMatch) rawRequirements.push({ line: lineNum, text: itemMatch[1] });
      continue;
    }

    // Poetry key-value format: requests = "^2.28.0" or requests = { version = "..." }
    if (currentSection.includes("poetry")) {
      const kvMatch = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1];
        if (key.toLowerCase() === "python") continue; // Python engine spec
        const val = kvMatch[2].replace(/#.*$/, "").trim();
        const strMatch = val.match(/^["']([^"']*)["']/);
        if (strMatch) {
          const spec = strMatch[1];
          if (spec === "*") {
            rawRequirements.push({ line: lineNum, text: key });
          } else if (/^\d+\./.test(spec)) {
            rawRequirements.push({ line: lineNum, text: `${key}==${spec}` });
          } else {
            rawRequirements.push({ line: lineNum, text: `${key}${spec}` });
          }
        } else if (val.startsWith("{")) {
          const vMatch = val.match(/version\s*=\s*["']([^"']+)["']/);
          rawRequirements.push({ line: lineNum, text: vMatch ? `${key}==${vMatch[1]}` : key });
        }
      }
    }
  }

  return diagnosePythonDeclarations(rawRequirements, filePath, "pyproject.toml");
}

/**
 * Diagnose package.json object or content.
 * @param {string|object} pkgInput
 * @param {string} filePath
 * @returns {{ ok: boolean, dependencyCount: number, findings: Array<object> }}
 */
export function diagnosePackageJson(pkgInput, filePath = "package.json") {
  let pkg;
  if (typeof pkgInput === "string") {
    try {
      pkg = JSON.parse(pkgInput.replace(/^\uFEFF/, ""));
    } catch (e) {
      return {
        ok: false,
        dependencyCount: 0,
        findings: [
          {
            category: "syntax-error",
            severity: "error",
            file: filePath,
            line: 1,
            dependency: "package.json",
            message: `Malformed package.json: ${e.message}`,
            detail: e.stack || String(e),
          },
        ],
      };
    }
  } else {
    pkg = pkgInput || {};
  }

  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const findings = [];
  const seenDeps = new Map();
  let dependencyCount = 0;

  for (const section of sections) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;

    for (const [name, versionSpec] of Object.entries(deps)) {
      dependencyCount++;
      const normName = name.trim().toLowerCase();
      const spec = typeof versionSpec === "string" ? versionSpec.trim() : "";

      // Check 1: Node.js stdlib shadowing
      if (NODE_BUILTIN_MODULES.has(normName)) {
        findings.push({
          category: "stdlib-shadowing",
          severity: "warn",
          file: filePath,
          section,
          dependency: name,
          message: `Dependency '${name}' in ${section} shadows Node.js built-in module`,
          detail: "Built-in Node.js module; declaring it as an external package is redundant or dangerous",
        });
      }

      // Check 2: Obsolete backports
      if (OBSOLETE_BACKPORTS[normName]) {
        findings.push({
          category: "obsolete-backport",
          severity: "warn",
          file: filePath,
          section,
          dependency: name,
          message: `Dependency '${name}' in ${section} is an obsolete backport: ${OBSOLETE_BACKPORTS[normName]}`,
          detail: OBSOLETE_BACKPORTS[normName],
        });
      }

      // Check 3: Unpinned
      if (!spec || spec === "*" || spec.toLowerCase() === "latest") {
        findings.push({
          category: "unpinned",
          severity: "warn",
          file: filePath,
          section,
          dependency: name,
          message: `Dependency '${name}' in ${section} is unpinned (${JSON.stringify(versionSpec)})`,
          detail: "Unpinned npm dependency risks non-reproducible installations and supply-chain drift",
        });
      }

      // Track exact versions for duplicate and conflict checks
      const isExact = /^\d+\.\d+\.\d+([a-zA-Z0-9_.-]*)$/.test(spec);
      const exactVersion = isExact ? spec : null;

      if (!seenDeps.has(normName)) {
        seenDeps.set(normName, []);
      }
      seenDeps.get(normName).push({ name, section, spec, exactVersion });
    }
  }

  // Check 4 & 5: Duplicates & exact conflicts across sections
  for (const [normName, declarations] of seenDeps.entries()) {
    if (declarations.length > 1) {
      const sectionNames = declarations.map((d) => d.section).join(" and ");
      findings.push({
        category: "duplicate",
        severity: "warn",
        file: filePath,
        dependency: declarations[0].name,
        message: `Dependency '${declarations[0].name}' is declared in multiple sections (${sectionNames})`,
        detail: `Redundant declaration of '${normName}'`,
      });

      const exacts = declarations.filter((d) => d.exactVersion !== null);
      const uniqueExacts = [...new Set(exacts.map((d) => d.exactVersion))];
      if (uniqueExacts.length > 1) {
        findings.push({
          category: "exact-conflict",
          severity: "error",
          file: filePath,
          dependency: declarations[0].name,
          message: `Exact version conflict for '${declarations[0].name}': declared as ${uniqueExacts.join(" vs ")} in ${sectionNames}`,
          detail: declarations.map((d) => `${d.section}: ${d.spec}`).join(" | "),
        });
      }
    }
  }

  const ok = findings.length === 0;
  return { ok, dependencyCount, findings };
}

const SKIP_DISCOVERY_DIRS = new Set([
  "node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "target", ".tmp",
]);

/**
 * Discovers and diagnoses dependency manifests in a directory tree.
 * @param {{ root?: string, files?: string[] }} options
 * @returns {{ ok: boolean, manifests: Array<object>, summary: object, findings: Array<object>, disclaimer: string }}
 */
export function diagnoseManifests(options = {}) {
  const root = options.root ? resolve(options.root) : process.cwd();
  const manifestPaths = [];

  if (Array.isArray(options.files) && options.files.length > 0) {
    for (const f of options.files) {
      const resolved = resolve(root, f);
      if (existsSync(resolved)) manifestPaths.push(resolved);
    }
  } else if (existsSync(root)) {
    const stat = statSync(root);
    if (!stat.isDirectory()) {
      manifestPaths.push(root);
    } else {
      const walk = (dir, depth = 0) => {
        if (depth > 3) return;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!SKIP_DISCOVERY_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
              walk(join(dir, entry.name), depth + 1);
            }
          } else if (entry.isFile()) {
            const lower = entry.name.toLowerCase();
            if (
              lower === "package.json" ||
              lower === "pyproject.toml" ||
              lower === "requirements.txt" ||
              (lower.startsWith("requirements") && lower.endsWith(".txt"))
            ) {
              manifestPaths.push(join(dir, entry.name));
            }
          }
        }
      };
      walk(root);
    }
  }

  const allFindings = [];
  const manifestReports = [];
  let totalDependencies = 0;

  for (const manifestPath of manifestPaths) {
    let content;
    try {
      content = readFileSync(manifestPath, "utf8");
    } catch (e) {
      allFindings.push({
        category: "read-error",
        severity: "error",
        file: manifestPath,
        message: `Failed to read manifest '${manifestPath}': ${e.message}`,
        detail: e.stack || String(e),
      });
      continue;
    }

    const bName = basename(manifestPath).toLowerCase();
    let report = null;

    if (bName === "package.json") {
      report = diagnosePackageJson(content, manifestPath);
    } else if (bName === "pyproject.toml") {
      report = diagnosePyproject(content, manifestPath);
    } else if (bName.includes("requirements") && bName.endsWith(".txt")) {
      report = diagnoseRequirements(content, manifestPath);
    }

    if (report) {
      manifestReports.push({
        path: manifestPath,
        type: bName === "package.json" ? "package.json" : bName === "pyproject.toml" ? "pyproject" : "requirements",
        dependencyCount: report.dependencyCount,
        findingCount: report.findings.length,
      });
      totalDependencies += report.dependencyCount;
      allFindings.push(...report.findings);
    }
  }

  const byCategory = {
    "stdlib-shadowing": 0,
    "obsolete-backport": 0,
    "unpinned": 0,
    "duplicate": 0,
    "exact-conflict": 0,
  };

  for (const f of allFindings) {
    if (Object.prototype.hasOwnProperty.call(byCategory, f.category)) {
      byCategory[f.category]++;
    }
  }

  const ok = allFindings.length === 0;

  return {
    ok,
    manifests: manifestReports,
    summary: {
      manifestCount: manifestReports.length,
      totalDependencies,
      totalFindings: allFindings.length,
      byCategory,
    },
    findings: allFindings,
    disclaimer: DISCLAIMER,
  };
}

/* ------------------------------------------------------------------ CLI Driver */

function printUsage() {
  process.stdout.write(`
dependency-doctor — offline dependency manifest diagnosis

Usage:
  node tools/dependency-doctor.mjs [path] [--root <dir>] [--json] [--check] [-h|--help]

Options:
  --root <dir>   Root directory to scan for dependency manifests (default: .)
  --json         Print machine-readable JSON output
  --check        Exit with non-zero code if actionable findings are detected
  -h, --help     Show this help message

Disclaimer:
  ${DISCLAIMER}
\n`);
}

function runCli(argv = process.argv.slice(2)) {
  let root = ".";
  let json = false;
  let check = false;
  const targetFiles = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--root") {
      root = argv[++i];
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    } else if (!arg.startsWith("-")) {
      targetFiles.push(arg);
    } else {
      process.stderr.write(`Unknown option: ${arg}\n`);
      process.exit(2);
    }
  }

  const report = diagnoseManifests({
    root,
    files: targetFiles.length > 0 ? targetFiles : undefined,
  });

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`\n=== Dependency Manifest Diagnosis ===\n`);
    process.stdout.write(`Manifests scanned: ${report.summary.manifestCount}\n`);
    process.stdout.write(`Total dependencies: ${report.summary.totalDependencies}\n`);
    process.stdout.write(`Total findings: ${report.summary.totalFindings}\n`);
    process.stdout.write(`  - stdlib shadowing: ${report.summary.byCategory["stdlib-shadowing"]}\n`);
    process.stdout.write(`  - obsolete backports: ${report.summary.byCategory["obsolete-backport"]}\n`);
    process.stdout.write(`  - unpinned: ${report.summary.byCategory["unpinned"]}\n`);
    process.stdout.write(`  - duplicates: ${report.summary.byCategory["duplicate"]}\n`);
    process.stdout.write(`  - exact conflicts: ${report.summary.byCategory["exact-conflict"]}\n\n`);

    if (report.findings.length > 0) {
      for (const f of report.findings) {
        const prefix = f.severity === "error" ? "🔴" : "⚠️";
        process.stdout.write(`${prefix} [${f.category}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}\n`);
      }
      process.stdout.write("\n");
    } else {
      process.stdout.write("✨ All checked manifests are clean.\n\n");
    }
    process.stdout.write(`Notice: ${report.disclaimer}\n\n`);
  }

  if (check && !report.ok) {
    process.exit(1);
  }
  process.exit(0);
}

const isDirectRun = Boolean(process.argv[1]) && (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  }
})();

if (isDirectRun) {
  runCli();
}
