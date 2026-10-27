# Manifest — auto-use CLI-Anything for GUI tasks without MCP

Source: user request + Wave 0 widget answers (2026-10-27).

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | Agent automatically uses CLI-Anything when a task needs driving a process through human UI and no MCP exists | "Я хочу чтобы мы это использовали автоматически если появляется задача с управлением каким то процессом в котором нет mcp и агент должен использовать человеческий UI" | open |
| R02 | Trigger is declarative inside the skill (no separate router file) | Wave 0 answer: "Декларативный триггер в скилле" | open |
| R03 | Scope covers desktop GUI AND web UI without MCP | Wave 0 answer: "Десктоп + веб без MCP" | open |
| R04 | Agent installs cli-hub packages silently, without asking | Wave 0 answer: "Автоустановка молча" | open |
| R05 | No MCP exists for the target process (precondition — MCP wins when present) | "в котором нет mcp" | open |
| R06 | Must not break existing browser skills (agent-browser, playwright-cli keep working) | implied by "автоматически" + repo honesty law | open |

## Constraints (from recon, not user — can be challenged)

- C1: delete-guard does NOT block `pip install` (6 rules: rm -rf, force-push, reset --hard, clean -f, find -delete, drop/truncate) — R04 needs no guard change.
- C2: Skill shape = SKILL.md with name/description/allowed-tools frontmatter (agent-browser pattern); registry = skills/ dir + skills-doctor health.
- C3: Overlap with agent-browser/playwright-cli on web tasks must be resolved by precedence text, not code (R02 forbids a router file).

## Acceptance (observable)

- A1: A task "automate GIMP export, no MCP" resolves to the new skill (description match), agent runs cli-hub search/install/launch without asking.
- A2: A task with an existing MCP (e.g. playwright) does NOT route to the new skill.
- A3: skills-doctor reports the new skill healthy; prompt-lint sizes stay green.
