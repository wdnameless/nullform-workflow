# Harness simplification

## Interfaces contract

Ownership zones are disjoint; one writer per file. The plan is **minimal by construction**:
deletion precedes abstraction, and the standard library precedes any helper.

### Hard rule for every task

**The standard library first. A helper only when measurement proves it necessary.** Both
directions were tested on this host (Node v24.17.0) and by blind acceptance:

| Capability | Runtime verdict | Consequence |
|---|---|---|
| `node:util.parseArgs` | supports `'string'`/`'boolean'`; unknown flags throw, but the tools that collect them are **3 test files**, and numeric flags need `Number()` | call it at the call sites — **no wrapper module** |
| `fs.readdirSync(root, {recursive:true})` | no descent predicate, but walking `tools/` (233 entries incl. `node_modules`) costs **~7–13 ms** and an in-memory filter under 1 ms | call it and filter — **no walker module** |
| `fs.renameSync` over a temp file | works; proven at `tools/workflow.mjs:118-126` | use the pattern inline at the one unsafe concurrent writer — **no state module** |

An earlier draft proposed seven modules, then three. Both were rejected: the first as
over-engineering, the second because measurement showed each "gap" was a few milliseconds or a
single `Number()` call. **This phase creates no shared modules at all.**

### Phase 1 — files that keep their public surface (defect fixes only)

| Path | Owner | Public surface that must not change | Change |
|---|---|---|---|
| `tools/workflow.mjs` | fixer | exports at `:1540`; `check`/`start`/`artifact`/`close` exit codes | `deviation.missing`, lane TTL, `mustContain` scoping, `default:` exit 2 |
| `tools/sync.ps1` · `tools/sync.sh` | fixer | `-Prune/-Promote/-Deploy/-Confirm/-Force/-Only` | reverse `<HARNESS>` before promote-write |
| `tools/prompt-lint.mjs` | fixer | `scan/baseline/check/fingerprint` | add the machine-path pattern |
| `tools/verify.mjs` | fixer | `--profile verify` / `--profile audit`; `testTierGate` (imported by `workflow-gate.test.mjs:18`) | 5 checks stop false-passing; 16 exports become 1 |
| `agent/agents/oracle.md` | orchestrator | role frontmatter | add `bash` |
| `agent/agents/designer.md` | orchestrator | role frontmatter + isolation line | make isolation conditional |

### Phase 3 — no new modules

| Capability | Today | Phase 3 action |
|---|---|---|
| argv parsing | 25 files | delete the parsers; call `node:util.parseArgs`, convert numerics with `Number()` |
| directory walk | 17 files | delete the walkers; call `fs.readdirSync(root, {recursive:true})` and filter |
| JSON state atomicity | 7 real writers, 1 unsafe concurrent one | fix that one inline (R08c); no module |
| git invocation | 15 call sites / 4 tools | leave in place; shared error handling is not duplicated today |
| root resolution | 5 files | leave alone unless a measured bug exists |
| markdown tables | several tools | leave alone; formatting a table is not a shared concern |
| `DEFAULT_BUDGETS`, ladder, excluded dirs | 2 definitions each | import from the defining module; no constants module |

### Phase 4 — split only where measured

Re-measure after Phase 2–3, then split only what still has two reasons to change.

| From | To | Justification today |
|---|---|---|
| `tools/dashboard.mjs` (2 942) | view → a template asset; collector + server stay | 868 lines of embedded HTML/CSS/JS in the same file as an HTTP server is the one split with measured cause |
| `tools/doctor.mjs` `runDoctor` | a check registry | one 920-line function |
| `tools/workflow.mjs`, `verify.mjs`, `benchmark.mjs` | **maybe nothing** | re-measure; splitting a 1 242-line module into three 400-line ones is a cost unless each part has one reason to change |

### Phase 5 — unification seams

| Today | After | Note |
|---|---|---|
| `tools/sync.ps1` (313) + `tools/sync.sh` (414), two identical 55-entry manifests | one `tools/sync.mjs` + `tools/sync-manifest.json`; per-OS shims | deletes 727 lines of twin logic |
| `install.ps1` (574) + `tools/install-harness.mjs` (627) | one engine + a Windows shim | POSIX installs gain plugins, provider config, doctor |

### Invariants every task must satisfy

1. `verify --profile verify` → 29/29; `--profile audit` → 14/14.
2. `node --test tools/tests/*.test.mjs` → 366 pass.
3. `node tools/auto-review.mjs --root .` → exit 0.
4. No tool imports another tool; shared behaviour is either deleted or inlined.
5. **Net line count must not rise.** Any step that adds more lines than it removes is
   rejected at review.
