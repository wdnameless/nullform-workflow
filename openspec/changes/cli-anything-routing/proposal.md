# cli-anything-routing — proposal

## Why
Tasks that drive a process through a human UI (desktop app, website without
an API) today have no deterministic home: the agent improvises between
`agent-browser`, `playwright-cli`, raw scripting, or giving up. HKUDS
CLI-Anything already solved the tool half (57k stars, Apache-2.0, `--json`
harnesses + SKILL.md per tool + `cli-hub` registry). What is missing is the
routing half: an automatic, declared rule that sends "GUI task, no MCP"
to CLI-Anything without a human pointing at it.

## What Changes
- **New skill `skills/cli-anything/SKILL.md`.** Declarative trigger in
  frontmatter description: desktop-GUI or web-UI task AND no MCP server
  covers the target. Body: preflight (`cli-hub can/search`), silent
  install (`cli-hub install`, scoped `--capability`), drive via
  `cli-anything-<name> --json`, verify artifacts exist.
- **Precedence text, not a router file** (Wave 0: declarative trigger).
  The skill states: MCP present → MCP wins; web + MCP absent →
  CLI-Anything before agent-browser/playwright-cli when a harness
  exists, else fall through to browser skills. No code decides.
- **Silent install is allowed by construction**: delete-guard has no
  `pip install` rule (verified); the skill documents the allowance so a
  future guard change must confront it explicitly.
- **No new tools, no registry code.** `cli-hub` is upstream's package
  manager; we consume it, we do not reimplement it.

## Non-Goals
- Porting any CLI-Anything harness into this repo.
- A code router/dispatcher (explicitly rejected in Wave 0).
- Web tasks where agent-browser already wins (no harness in hub).
