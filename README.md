# Nullform Workflow — OMP + Paseo orchestration harness

A complete AI-agent orchestration stack: lane classifier (T0–T3), 4-Wave SDD with
requirements traceability, 60+ skills, curated MCP fleet, shared Hindsight memory,
and a single Nullform model gateway. Battle-tested, with an autopilot-derived
execution protocol (context ceilings, handoffs, blind acceptance).

## One-command install (Windows)

```powershell
git clone <this-repo> ; cd omp-paseo-nullform-workflow
copy secrets.example.env secrets.env   # fill in your keys first (or be prompted)
powershell -ExecutionPolicy Bypass -File install.ps1
```

## One-command verification

```powershell
powershell -ExecutionPolicy Bypass -File verify.ps1
```

Expected: `12/12 checks passed` (openspec, skills count, junction, configs valid,
session_cost selftest 7/7, hindsight 200, crawl4ai 200/401, gateway models 200,
grill chain, test-safety skill).

## Secrets

| Key | Where it goes | Get it |
|---|---|---|
| `NULLFORM_GATEWAY_KEY` | `models.yml` apiKey | your nullform.cv deployment |
| `HINDSIGHT_TOKEN` | `mcp.json` → hindsight headers | your memory server |
| `CRAWL4AI_TOKEN` | `mcp.json` → crawl4ai headers | your crawl dedik |
| `GOOGLE_AI_STUDIO_KEY` | `~/.local/share/opencode/auth.json` | ai.google.dev (embeddings for codebase-index) |

Configs ship as `*.example` with `__PLACEHOLDERS__`; the installer patches them.
Real keys never belong in git (`.gitignore` covers `secrets.env`).

## What is inside

```
agent/
  AGENTS.md            orchestrator law (auto-loaded context file)
  agents/              11 role definitions (orchestrator, designer, fixer, oracle, scout, …)
  config.yml           OMP settings (model roles, timeouts, isolation)
  models.yml.example   single provider: nullform-gateway, 28 models, no dupes
  mcp.json.example     8 MCP servers (hindsight, crawl4ai, codebase-index, playwright,
                       ast-grep, dap-debugger, codegraph, context7)
skills/                60+ skills incl. grill-me + grilling, design-taste-frontend,
                       project-test-safety, nullform-workflow-full
rules/
  enterprise-directives.md   on-demand rule (git/PR, ports, DB, secrets redaction gate)
mcp/gbrain-lite.ts     optional MCP tool-filter proxy pattern
tools/session_cost.py  session cost reporter (tokens per model/day; --selftest 7/7)
paseo/profiles.json    Orchestrator (LEAN) launch profile
```

## How the workflow runs (short)

1. Every task classifies first: `⚡T0` direct · `🔧T1` recon + 1–2 specialists ·
   `🚀T2` full 4-Wave SDD · `🌌T3` program slices.
2. T2: Wave 0 `grill-me` interview via ONE ask-widget → `manifest.md` with verbatim
   user quotes (R01…) → OpenSpec change (`openspec validate`) → G-gates (G2/G4 by an
   independent reader, blind vs the brief, never vs our spec) → parallel build waves
   (≤3 in flight, disjoint zones, `interfaces.md` shared contract) → blind @oracle.
3. Subagents: fresh context each, ~50 tool-call ceiling, HANDOFF protocol,
   ≤25-line return contract (STATUS/FILES/TESTS было→стало/INTERFACES/REQUIREMENTS).
4. Memory: recall at task start, retain at task end (hindsight, bank `main`).

Full law: `agent/AGENTS.md` + `agent/agents/orchestrator.md`.

## After install

- Open a NEW OMP/Paseo session (skills/MCP mount at session start).
- Give any T2 task — the first thing you should see is the ask widget.
- Report cost of any session: `python D:\ohmypi\tools\session_cost.py <transcript.jsonl>`
