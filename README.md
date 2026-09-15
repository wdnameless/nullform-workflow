# OMP Workflow — an agentic-engineering harness for Oh My Pi

A complete orchestration stack for OMP: lane classifier (T0–T3), 4-Wave SDD with
requirements traceability, a role fleet, 65+ skills, drift control, prompt-cache
safety, and runtime verification tooling.

**Provider-agnostic.** Nothing here assumes a particular vendor: you supply an
OpenAI-compatible endpoint and a model id. The MCP fleet is optional — the agent
definitions, rules, skills, and tools all work without a single MCP server.

## Install (one prompt)

Paste this into any agent that can run shell commands (OMP, Claude Code, Cursor):

```
Clone https://github.com/wdnameless/omp-workflow to ~/omp-workflow, then run
`powershell -ExecutionPolicy Bypass -File ~/omp-workflow/install.ps1` and answer
its prompts (model provider base URL, API key, model id — all optional, and the
optional MCP service URLs can be left blank).
```

The installer is interactive by default and idempotent — re-run it after a
`git pull` to update. Non-interactive from a filled-in secrets file:

```powershell
copy secrets.example.env secrets.env   # then edit
powershell -ExecutionPolicy Bypass -File install.ps1 -NonInteractive
```

## Verify

```powershell
powershell -ExecutionPolicy Bypass -File verify.ps1
```

Prints a PASS/FAIL table; exit 0 means every layer is sound. It checks YOUR
configuration is well-formed and that the harness mechanics work — it does not
assert that any external service exists.

## What you must supply

Everything is optional except a model endpoint (and you can install without one,
then fill it in later).

| Value | Goes into | Notes |
|---|---|---|
| Provider base URL | `models.yml` `baseUrl` | OpenAI-compatible, usually ends in `/v1` |
| Provider API key | `models.yml` `apiKey` | never committed; `secrets.env` is git-ignored |
| Default model id | `models.yml` + role selectors | whatever your provider calls it |
| Memory MCP URL + token | `mcp.json` | optional; skip and the entry is dropped |
| Crawl MCP URL + token | `mcp.json` | optional; skip and the entry is dropped |
| context7 API key | `mcp.json` | optional; context7 works keyless at a lower limit |

All configs ship as `*.example` with `__PLACEHOLDERS__`; the installer patches
them. Leave an optional value blank and its entry is removed rather than left
half-configured (a server that fails to connect on every session boot is worse
than an absent one).

## Swapping in your own provider

`agent/models.yml.example` declares one provider named `my-provider`. Rename it
freely, then update `agent/config.yml`'s `modelRoles` to match — selectors are
`<provider-id>/<model-id>`. Point every role at the same model first; split them
later (`smol`/`task`/`explorer` onto something cheap, `slow`/`plan` onto your
strongest) once you know what your provider offers.

## What is inside

```
agent/
  AGENTS.md            orchestrator law (auto-loaded every session)
  agents/              11 role definitions (orchestrator, designer, fixer, oracle, scout, …)
  config.yml.example   OMP settings (model roles, timeouts, isolation)
  models.yml.example   one OpenAI-compatible provider, edit to taste
  mcp.json.example     optional MCP fleet, every entry documented + droppable
  agents/*.md          role contracts: scopes, return contract, ceilings
skills/                65+ skills: grill-me/grilling, design suite, test-safety,
                       nullform-workflow-full, and the engineering disciplines —
                       domain-modeling, codebase-design, diagnosing-bugs,
                       codemap, deepwork
rules/
  enterprise-directives.md   on-demand rule (git/PR, ports, DB, secrets redaction)
tools/
  codemap.mjs          repo cartography + change tracking (no deps)
  prompt-lint.mjs      prompt-cache safety: volatile-literal scan + baseline drift
  skills-doctor.mjs    detects skills the registry would drop silently
  glossary.mjs         CONTEXT.md bootstrap + vocabulary-drift check
  replay.mjs           record/replay network cassettes for runtime verification
  audit.ps1            all mechanical checks in one verdict (exit 0/1)
  sync.ps1             drift control between a repo clone and a live install
  session_cost.py      token/cost reporter per model per day
templates/paseo.json   Paseo workspace-script template (supervised dev servers)
paseo/profiles.json    Paseo launch profile
CONTEXT.md             the workflow's own domain glossary (dogfood)
```

## How it runs

1. Every task classifies first: `T0` direct · `T1` recon + 1–2 specialists ·
   `T2` full 4-Wave SDD · `T3` program slices.
2. T2: Wave 0 `grill-me` interview via ONE ask-widget → `manifest.md` with
   verbatim user quotes (R01…) → OpenSpec change → G-gates → parallel build waves
   (disjoint file ownership, `interfaces.md` shared contract) → blind `@oracle`.
3. Subagents get fresh context each, a ≤25-line return contract
   (STATUS/FILES/TESTS/INTERFACES/CONCERNS), and HANDOFF at ~45 tool calls — the
   internal budget is 100, but a hosted gateway may cap requests per minute, so
   lanes stop well before it.
4. Disciplines are enforced, not just documented: an undocumented public domain
   symbol is an Oracle REJECT (`domain-modeling`); interfaces must survive the
   deletion test (`codebase-design`); a bug is diagnosed by the 6-phase protocol
   before any code is touched (`diagnosing-bugs`); a network-path change needs a
   replay cassette, because a mock written alongside the code is not evidence.
5. Long-lived services (dev servers, watchers) are supervised by Paseo workspace
   scripts — never owned by a subagent that dies and leaks the port.

Full law: `agent/AGENTS.md` + `agent/agents/orchestrator.md`.

## Maintenance

```powershell
powershell -File tools/audit.ps1               # one verdict across all checks
powershell -File tools/sync.ps1                # drift between clone and live install
powershell -File tools/sync.ps1 -Promote       #   live -> clone
powershell -File tools/sync.ps1 -Deploy        #   clone -> live
node tools/prompt-lint.mjs baseline --root .   # re-record cache baseline after an intentional edit
python tools/session_cost.py <transcript.jsonl>
```

## After install

- Open a NEW OMP session — skills, MCP, and `AGENTS.md` load at session start.
- Give it a real task. A T2 task should open with the ask widget, not code.

## License

MIT
