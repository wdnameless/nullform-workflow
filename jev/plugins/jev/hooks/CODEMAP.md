# jev/plugins/jev/hooks/

## Responsibility
Middleware and event interception layer for Claude Code CLI. Intercepts user prompt submissions (`UserPromptSubmit`) to evaluate task complexity, conversational context dependence, and relevant skills via the Jev classification API, injecting routing instructions and skill recommendations into Claude's context.

## Design Patterns
- **Interceptor / Middleware**: Intercepts prompt submission before Claude processes it; fails open silently on any exception without disrupting the session.
- **Strategy Pattern**: Selects model routing strategy (`route()`) based on evaluated complexity levels, current session model, and context dependency.
- **Two-Pass Pipeline / Progressive Filtering**: Filters inputs (slash commands, secret regex, prompt length), runs coarse classification, and refines low-confidence skill matches (`recheck_skill()`).

## Data & Control Flow
1. **Invocation**: Claude Code invokes `python3 before_prompt.py` configured via `hooks.json` on `UserPromptSubmit`.
2. **Ingress & Sanitization**: Hook reads event JSON from `stdin` (`prompt`, `session_id`, `permission_mode`), drops secrets and command shortcuts, and loads project config/state via `jev_client`.
3. **Inference**: Sends scoring and classification questions to Jev API (`jc.ask()`); optionally executes a second-pass detailed prompt for borderline skill matches.
4. **Resolution**: `route()` calculates whether to execute locally, delegate to a subagent (`Agent`), or recommend a model switch (`/model <target>`).
5. **Egress**: Emits `{ "hookSpecificOutput": { "additionalContext": ... } }` JSON to `stdout`, logs telemetry to disk, and exits `0`.

## Integration Points
- **Claude Code CLI**: Wired via `hooks.json` under `UserPromptSubmit` (`${CLAUDE_PLUGIN_ROOT}/hooks/before_prompt.py`, timeout 8s); consumes `stdin` event payload and yields `additionalContext` on `stdout`.
- **Jev Client (`scripts/jev_client.py`)**: Imports helper functions for credentials, skill frontmatter parsing, API queries (`ask`), session persistence, and audit logging.
- **Jev API**: External HTTP inference endpoint evaluating prompt complexity, context dependency, and skill match probabilities.
