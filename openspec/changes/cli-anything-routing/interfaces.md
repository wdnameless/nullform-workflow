# cli-anything-routing — interfaces

One module (skill file), zero code. Functions-first: the only function is
"route GUI-without-MCP tasks to CLI-Anything declaratively", so the module
list has exactly one entry — no `shared/` zone, nothing to split.

## `skills/cli-anything/SKILL.md` (new, owner: Wave 3 writer)

- **Frontmatter** (the trigger — the whole routing decision):
  - `name: cli-anything`
  - `description`: MUST contain: (a) desktop-GUI + web-UI task coverage,
    (b) "no MCP" precondition with MCP-wins precedence, (c) cli-hub
    install/drive verbs. This text IS the interface agents match on.
  - `allowed-tools`: `Bash(pip install cli-anything-hub)`,
    `Bash(cli-hub:*)`, `Bash(cli-anything-*)` — silent install allowed.
- **Body sections** (each ≤30 lines, total ≤200):
  1. Preflight: `cli-hub can "<intent>"` / `matrix preflight --json`.
  2. Scoped install: `cli-hub install <name> --capability <id>`, no bulk.
  3. Drive: `cli-anything-<name> --json …`; verify artifacts exist.
  4. Precedence: MCP > CLI-Anything (harness exists) > browser skills.
  5. Silent-install allowance + its audit note (guard has no pip rule).
- **Consumers**: any agent session resolving skills by description.
  No imports, no callers, no tests import it (health via skills-doctor).

## Explicitly NOT created

- No `tools/cli-anything-*.mjs` (upstream owns the tooling).
- No router/dispatcher module (Wave 0 rejected).
- No changes to agent-browser/playwright-cli skills (R06: untouched).
