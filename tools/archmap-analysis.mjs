/**
 * tools/archmap-analysis.mjs
 * Semantic JS/TS AST and call graph analysis using TypeScript Compiler API.
 * Supports:
 * - Nested, arrow, function, class, method, getter, setter, constructor symbols
 * - Module initializer pseudo-symbol (`module`)
 * - Static call graph linking callers to symbol targets across files and local scopes
 * - Handling aliases, re-exports, shadowing, constructors (`new Foo()`)
 * - Tracking unresolved, external, dynamic calls with Russian-translated reason descriptions
 * - Compiler-resolved project-internal file dependencies (`fileDeps`) honouring tsconfig paths/baseUrl
 * - tsconfig.json safe reading (never executing scanned code)
 * - Fallback graceful reporting when TypeScript is not installed
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname, extname, relative, resolve } from "node:path";

const posix = (p) => p.split("\\").join("/");

const JS_TS_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"
]);

/**
 * Safely reads tsconfig.json or jsconfig.json from directory tree without executing code.
 */
function loadCompilerOptions(ts, rootDir) {
  if (!ts) return {};
  const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists, "tsconfig.json")
    || ts.findConfigFile(rootDir, ts.sys.fileExists, "jsconfig.json");

  if (!configPath) {
    return {
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.Node10 ?? ts.ModuleResolutionKind.NodeJs,
      jsx: ts.JsxEmit.Preserve,
      skipLibCheck: true,
      noEmit: true
    };
  }

  try {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      return {
        allowJs: true,
        target: ts.ScriptTarget.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.Node10 ?? ts.ModuleResolutionKind.NodeJs,
        skipLibCheck: true
      };
    }
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      dirname(configPath),
      {},
      configPath
    );
    return {
      ...parsed.options,
      allowJs: true,
      noEmit: true,
      skipLibCheck: true
    };
  } catch {
    return {
      allowJs: true,
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext ?? ts.ModuleResolutionKind.NodeJs,
      skipLibCheck: true
    };
  }
}

/**
 * Normalized lookup: absolute path (native or POSIX, any drive-letter case) -> relative POSIX path.
 * Returns null when the file is not part of the scanned project (node_modules, lib.d.ts, outside root).
 */
function relFromFullPath(fullToRel, fileName) {
  if (!fileName) return null;
  return fullToRel.get(fileName)
    || fullToRel.get(fileName.toLowerCase())
    || fullToRel.get(posix(fileName).toLowerCase())
    || null;
}

/**
 * Collects the module specifiers a source file pulls in: static `import` (including
 * side-effect-only `import "./x"`), `export ... from`, and `import x = require(...)`.
 * Dynamic `import()` expressions are deliberately ignored.
 */
function collectModuleSpecifiers(ts, statement) {
  const specs = [];
  const push = (node) => {
    if (node && ts.isStringLiteralLike(node)) specs.push(node.text);
  };

  if (ts.isImportDeclaration(statement)) {
    push(statement.moduleSpecifier);
  } else if (ts.isExportDeclaration(statement)) {
    push(statement.moduleSpecifier);
  } else if (ts.isImportEqualsDeclaration(statement)) {
    const ref = statement.moduleReference;
    if (ref && ts.isExternalModuleReference(ref)) push(ref.expression);
  }
  return specs;
}

/**
 * Resolves project-internal file dependencies the way the TypeScript compiler does:
 * tsconfig `baseUrl`/`paths` aliases, extensionless specifiers, ESM extension
 * substitution ("./x.js" -> "./x.ts", "./x.mjs" -> "./x.mts") and re-export chains.
 * Only edges between scanned project files are kept — node_modules, lib.d.ts and
 * unresolved specifiers are dropped. Nothing is executed; files are only read.
 *
 * @param {string[]} rootNames - absolute paths of the files requested for analysis
 * @returns {Map<object, Set<string>>} TypeScript SourceFile -> set of relative POSIX deps
 */
function collectCompilerFileDeps(ts, program, rootNames, options, host, fullToRel) {
  const deps = new Map();

  const visited = new Set();
  const queue = [];
  for (const name of rootNames) {
    const sf = program.getSourceFile(name);
    if (sf) queue.push(sf);
  }

  while (queue.length) {
    const sf = queue.shift();
    if (!sf || visited.has(sf)) continue;
    visited.add(sf);

    const relPath = relFromFullPath(fullToRel, sf.fileName);
    if (!relPath) continue;

    for (const statement of sf.statements) {
      for (const spec of collectModuleSpecifiers(ts, statement)) {
        let resolved = null;
        try {
          resolved = ts.resolveModuleName(spec, sf.fileName, options, host).resolvedModule;
        } catch {
          resolved = null;
        }
        if (!resolved) continue;

        // Membership in the scanned project decides the edge: files outside `fullToRel`
        // (node_modules, lib.*.d.ts, anything above the root) are dropped as external.
        const targetSf = program.getSourceFile(resolved.resolvedFileName);
        const targetRel = relFromFullPath(fullToRel, resolved.resolvedFileName)
          || (targetSf ? relFromFullPath(fullToRel, targetSf.fileName) : null);
        if (!targetRel || targetRel === relPath) continue;

        let set = deps.get(sf);
        if (!set) { set = new Set(); deps.set(sf, set); }
        set.add(targetRel);

        // Follow compiler-resolved targets so aliased re-export chains stay exact.
        if (targetSf) queue.push(targetSf);
      }
    }
  }

  return deps;
}

/**
 * Checks if a declaration node represents a callable symbol container.
 */
function isCallableDeclaration(ts, node) {
  return ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node);
}

/**
 * Returns symbol kind for declaration.
 */
function getDeclarationKind(ts, node) {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isGetAccessorDeclaration(node)) return "getter";
  if (ts.isSetAccessorDeclaration(node)) return "setter";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isArrowFunction(node)) return "arrow";
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return "function";
  return "symbol";
}

/**
 * Extracts a readable name for a declaration node.
 */
function getDeclarationName(ts, node, sourceFile) {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (node.name) {
    return node.name.getText(sourceFile);
  }

  // Check parent variable declaration if arrow or function expression
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    let parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent) && parent.name && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (parent && ts.isPropertyAssignment(parent) && parent.name) {
      return parent.name.getText(sourceFile);
    }
    if (parent && ts.isBinaryExpression(parent) && parent.left) {
      return parent.left.getText(sourceFile);
    }
  }

  return "anonymous";
}

/**
 * Analyses JS/TS files using TypeScript Compiler API.
 * 
 * @param {string} root - project root directory
 * @param {string[]} relFilePaths - relative POSIX file paths to scan
 * @param {object} [existingFiles] - existing file analysis objects
 * @returns {Promise<{
 *   symbols: Array<{id: string, file: string, name: string, kind: string, line: number, endLine: number}>,
 *   calls: Array<{from: string, to: string, file: string, line: number}>,
 *   unresolvedCalls: Array<{from: string, file: string, line: number, expression: string, reason: string}>,
 *   fileDeps: Record<string, string[]>,
 *   analysis: {
 *     engine: string,
 *     supportedExtensions: string[],
 *     limitations: string[],
 *     diagnostics: Array<{file: string, line: number, message: string}>
 *   }
 * }>}
 */
export async function analyzeProjectJsTs(root, relFilePaths, existingFiles = {}) {
  let ts;
  try {
    ts = (await import("typescript")).default;
  } catch (err) {
    // Graceful fallback if typescript is not installed
    return {
      symbols: [],
      calls: [],
      unresolvedCalls: [],
      fileDeps: {},
      analysis: {
        engine: "typescript-ast (не установлен пакет typescript)",
        supportedExtensions: Array.from(JS_TS_EXTENSIONS),
        limitations: [
          "Пакет typescript не установлен в tools/node_modules. Семантический анализ вызовов JS/TS пропущен.",
          "Для полного графа функций выполните: cd tools && npm install"
        ],
        diagnostics: [{
          file: "",
          line: 1,
          message: "TypeScript compiler API недоступен: установите зависимость typescript."
        }]
      }
    };
  }

  const jsTsRelFiles = relFilePaths.filter((p) => JS_TS_EXTENSIONS.has(extname(p).toLowerCase()));
  const fullPaths = jsTsRelFiles.map((p) => resolve(root, p));
  const fullToRel = new Map();
  fullPaths.forEach((fp, i) => {
    fullToRel.set(fp, jsTsRelFiles[i]);
    // Also normalize lowercase for Windows case-insensitivity
    fullToRel.set(fp.toLowerCase(), jsTsRelFiles[i]);
    fullToRel.set(posix(fp).toLowerCase(), jsTsRelFiles[i]);
  });

  const compilerOptions = loadCompilerOptions(ts, root);
  const compilerHost = ts.createCompilerHost(compilerOptions, true);

  const program = ts.createProgram({
    rootNames: fullPaths,
    options: compilerOptions,
    host: compilerHost
  });

  const checker = program.getTypeChecker();
  const diagnostics = [];
  const symbols = [];
  const calls = [];
  const unresolvedCalls = [];

  // Map from AST node -> symbol ID
  const nodeToSymbolId = new Map();
  // Map from symbol ID -> symbol object
  const symbolById = new Map();

  // Collect syntactic and config diagnostics from program
  try {
    const configDiags = program.getConfigFileParsingDiagnostics() || [];
    for (const d of configDiags) {
      const msg = typeof d.messageText === "string" ? d.messageText : d.messageText?.messageText || "Ошибка конфигурации tsconfig";
      diagnostics.push({
        file: d.file ? (fullToRel.get(d.file.fileName) || d.file.fileName) : "tsconfig.json",
        line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 1,
        message: `Конфигурация TS: ${msg}`
      });
    }

    const synDiags = program.getSyntacticDiagnostics() || [];
    for (const d of synDiags) {
      if (d.file) {
        const rel = fullToRel.get(d.file.fileName)
          || fullToRel.get(d.file.fileName.toLowerCase())
          || fullToRel.get(posix(d.file.fileName).toLowerCase());
        if (rel) {
          const msg = typeof d.messageText === "string" ? d.messageText : d.messageText?.messageText || "Синтаксическая ошибка";
          const line = d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 1;
          diagnostics.push({
            file: rel,
            line,
            message: `Синтаксис: ${msg}`
          });
        }
      }
    }
  } catch {
    // Non-fatal if diagnostics collection encounters issues
  }

  // Compiler-resolved project-internal file dependencies (tsconfig paths/baseUrl aware).
  const compilerFileDeps = collectCompilerFileDeps(
    ts, program, fullPaths, compilerOptions, compilerHost, fullToRel
  );
  const fileDeps = {};
  for (const relPath of jsTsRelFiles) {
    const set = compilerFileDeps.get(program.getSourceFile(resolve(root, relPath)));
    fileDeps[relPath] = set ? Array.from(set).sort() : [];
  }

  // 1. First pass: Collect all symbols (functions, methods, classes, constructors, getters, setters, modules)
  for (const relPath of jsTsRelFiles) {
    const fullPath = resolve(root, relPath);
    const sf = program.getSourceFile(fullPath);
    if (!sf) continue;

    // Module-level pseudo symbol for file initialization
    const moduleSymbolId = `${relPath}#module:init:0`;
    const moduleSymbol = {
      id: moduleSymbolId,
      file: relPath,
      name: `${relPath} (модуль)`,
      kind: "module",
      line: 1,
      endLine: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1
    };
    symbols.push(moduleSymbol);
    symbolById.set(moduleSymbolId, moduleSymbol);

    // Keep tracked member IDs for extending existing file.members
    const fileMembers = existingFiles[relPath]?.members;

    const visitDeclarations = (node) => {
      if (isCallableDeclaration(ts, node)) {
        const startPos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const endPos = sf.getLineAndCharacterOfPosition(node.getEnd());
        const startOffset = node.getStart(sf);
        const line = startPos.line + 1;
        const endLine = endPos.line + 1;
        const kind = getDeclarationKind(ts, node);
        const name = getDeclarationName(ts, node, sf);

        const symId = `${relPath}#${kind}:${name}:${line}:${startOffset}`;
        const symObj = {
          id: symId,
          file: relPath,
          name,
          kind,
          line,
          endLine
        };

        symbols.push(symObj);
        symbolById.set(symId, symObj);
        nodeToSymbolId.set(node, symId);

        // Also map parent VariableDeclaration if node is arrow or function expression
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          if (node.parent && ts.isVariableDeclaration(node.parent)) {
            nodeToSymbolId.set(node.parent, symId);
          }
        }

        // Link with file.members if matching
        if (Array.isArray(fileMembers)) {
          for (const m of fileMembers) {
            if (m.name === name && Math.abs(m.line - line) <= 1) {
              m.id = symId;
              break;
            }
          }
        }
      }

      ts.forEachChild(node, visitDeclarations);
    };

    visitDeclarations(sf);
  }

  // Helper to find enclosing symbol for an AST node
  function getEnclosingSymbolId(node, sourceFile, relPath) {
    let curr = node.parent;
    while (curr) {
      if (nodeToSymbolId.has(curr)) {
        return nodeToSymbolId.get(curr);
      }
      curr = curr.parent;
    }
    return `${relPath}#module:init:0`;
  }

  // 2. Second pass: Trace call expressions and resolve targets
  const seenCallEdges = new Set();

  for (const relPath of jsTsRelFiles) {
    const fullPath = resolve(root, relPath);
    const sf = program.getSourceFile(fullPath);
    if (!sf) continue;

    const visitCalls = (node) => {
      const isCall = ts.isCallExpression(node);
      const isNew = ts.isNewExpression(node);

      if (isCall || isNew) {
        const callExpr = node.expression;
        const startPos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const line = startPos.line + 1;
        const callerId = getEnclosingSymbolId(node, sf, relPath);
        
        let exprText = "";
        try {
          exprText = callExpr.getText(sf).slice(0, 100);
        } catch {
          exprText = isNew ? "new" : "call";
        }

        // Attempt resolution via TypeScript TypeChecker
        let resolved = false;
        let tsSymbol = checker.getSymbolAtLocation(callExpr);

        // If direct lookup didn't yield a symbol, try property or identifier
        if (!tsSymbol) {
          if (ts.isPropertyAccessExpression(callExpr)) {
            tsSymbol = checker.getSymbolAtLocation(callExpr.name);
          } else if (ts.isElementAccessExpression(callExpr)) {
            // Dynamic member access obj[prop]()
            unresolvedCalls.push({
              from: callerId,
              file: relPath,
              line,
              expression: exprText,
              reason: "dynamic"
            });
            resolved = true;
          }
        }

        // Handle aliases (imports, re-exports)
        if (tsSymbol && (tsSymbol.flags & ts.SymbolFlags.Alias)) {
          try {
            tsSymbol = checker.getAliasedSymbol(tsSymbol);
          } catch {
            // Unresolved alias
          }
        }

        if (tsSymbol && !resolved) {
          const decls = tsSymbol.getDeclarations() || [];
          let targetDecl = null;
          let targetSf = null;

          for (const d of decls) {
            const declSf = d.getSourceFile();
            if (declSf) {
              const sfPath = declSf.fileName;
              const normSf = fullToRel.get(sfPath) || fullToRel.get(sfPath.toLowerCase()) || fullToRel.get(posix(sfPath).toLowerCase());
              if (normSf) {
                targetDecl = d;
                targetSf = declSf;
                break;
              }
            }
          }

          if (targetDecl && targetSf) {
            let targetSymId = null;

            // (1) If this is `new Foo()`, look for explicit constructor inside target class or resolved signature
            if (isNew) {
              let candidateClass = targetDecl;
              if (ts.isVariableDeclaration(targetDecl) && targetDecl.initializer && ts.isClassDeclaration(targetDecl.initializer)) {
                candidateClass = targetDecl.initializer;
              }
              if (ts.isClassDeclaration(candidateClass)) {
                const ctor = candidateClass.members?.find((m) => ts.isConstructorDeclaration(m));
                if (ctor && nodeToSymbolId.has(ctor)) {
                  targetSymId = nodeToSymbolId.get(ctor);
                } else if (nodeToSymbolId.has(candidateClass)) {
                  targetSymId = nodeToSymbolId.get(candidateClass);
                }
              }
            }

            // (2) If target declaration is a VariableDeclaration, inspect its initializer
            if (!targetSymId && ts.isVariableDeclaration(targetDecl)) {
              if (targetDecl.initializer && nodeToSymbolId.has(targetDecl.initializer)) {
                targetSymId = nodeToSymbolId.get(targetDecl.initializer);
              } else if (nodeToSymbolId.has(targetDecl)) {
                targetSymId = nodeToSymbolId.get(targetDecl);
              }
            }

            // (3) If resolved signature declaration is available via TypeChecker, check it
            if (!targetSymId) {
              try {
                const sig = checker.getResolvedSignature(node);
                const sigDecl = sig?.declaration;
                if (sigDecl && nodeToSymbolId.has(sigDecl)) {
                  targetSymId = nodeToSymbolId.get(sigDecl);
                }
              } catch {
                // Ignore signature resolution failures
              }
            }

            // (4) Check direct nodeToSymbolId on targetDecl
            if (!targetSymId && nodeToSymbolId.has(targetDecl)) {
              targetSymId = nodeToSymbolId.get(targetDecl);
            }

            // (5) If target declaration is a class (called without new, e.g. class reference)
            if (!targetSymId && ts.isClassDeclaration(targetDecl)) {
              const ctor = targetDecl.members?.find((m) => ts.isConstructorDeclaration(m));
              if (ctor && nodeToSymbolId.has(ctor)) {
                targetSymId = nodeToSymbolId.get(ctor);
              } else if (nodeToSymbolId.has(targetDecl)) {
                targetSymId = nodeToSymbolId.get(targetDecl);
              }
            }

            if (targetSymId) {
              const edgeKey = `${callerId}->${targetSymId}@${relPath}:${line}`;
              if (!seenCallEdges.has(edgeKey)) {
                seenCallEdges.add(edgeKey);
                calls.push({
                  from: callerId,
                  to: targetSymId,
                  file: relPath,
                  line
                });
              }
              resolved = true;
            }
          } else if (decls.length > 0) {
            // Target declaration exists but outside project source files (e.g. node_modules, lib.d.ts)
            unresolvedCalls.push({
              from: callerId,
              file: relPath,
              line,
              expression: exprText,
              reason: "external"
            });
            resolved = true;
          }
        }

        if (!resolved) {
          // Check reason: is it dynamic, external or unresolved identifier?
          let reason = "unresolved";
          if (ts.isElementAccessExpression(callExpr) || exprText.includes("[") || exprText.includes("?") || exprText.includes("(")) {
            reason = "dynamic";
          } else if (/^(require|import|console|process|Math|JSON|Object|Array|Promise|String|Number|Boolean|fetch|setTimeout|setInterval|clearTimeout|clearInterval)\b/.test(exprText)) {
            reason = "external";
          }

          unresolvedCalls.push({
            from: callerId,
            file: relPath,
            line,
            expression: exprText,
            reason
          });
        }
      }

      ts.forEachChild(node, visitCalls);
    };

    visitCalls(sf);
  }

  // Synthesize limitations in Russian
  const limitations = [
    "Статический анализ ограничен кодом JavaScript и TypeScript. Для файлов Python, Go, Rust и других поддерживается только граф модулей и эвристический список членов.",
    "Динамические вызовы через скобки (obj[fn]()), `eval` и вызовы функций высшего порядка через параметры не разрешаются в конкретные целевые узлы и фиксируются как dynamic.",
    "Вызовы внешних библиотек и рантайма Node.js/Web API классифицируются как external и не создают фиктивных внутренних ребер."
  ];

  return {
    symbols,
    calls,
    unresolvedCalls,
    fileDeps,
    analysis: {
      engine: `typescript-compiler-api ${ts.version}`,
      supportedExtensions: Array.from(JS_TS_EXTENSIONS),
      limitations,
      diagnostics
    }
  };
}
