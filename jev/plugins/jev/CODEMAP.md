# jev/plugins/jev/

## Responsibility
Claude Code plugin package and middleware layer integrating the Jev (TypeSafe) classification engine. Provides prompt-interception middleware for automated model routing and skill suggestion, a CLI toolchain for batch dataset evaluation and ground-truth validation, and interactive skills for agent orchestration.

## Design Patterns
- **Plugin / Extension**: Conforms to Claude Code plugin specifications via `.claude-plugin/plugin.json`, registering declarative hooks and skills.
- **Middleware / Interceptor**: `UserPromptSubmit` hook intercepts user input before agent execution to classify complexity and context reliance.
- **Strategy & Router**: Tier-based model routing (Haiku, Sonnet, Opus, Fable) determining whether to execute directly, delegate to subagents, or switch models.
- **Façade / Client**: `jev_client.py` encapsulates TypeSafe / OpenRouter HTTP communication and response parsing.

## Data & Control Flow
- **Prompt Interception**: Claude Code triggers `hooks/before_prompt.py` on `UserPromptSubmit`. The hook redacts secrets, loads configuration (`questions.json`), and queries Jev API via `jev_client.py`.
- **Routing & Context Injection**: Confident classifications (complexity, context dependency, skill suggestion) are injected into Claude's prompt context.
- **Batch & Evaluation**: Skills invoke `scripts/jev.py`, which reads input datasets (CSV, JSONL, files), queries Jev concurrently via `ThreadPoolExecutor`, and writes `.jev.csv` evaluation matrices.

## Integration Points
- **Hooks**: Claude Code `UserPromptSubmit` event declared in `hooks/hooks.json`.
- **External APIs**: TypeSafe (`https://api.typesafe.ai/v1`) or OpenRouter endpoints using `JEV_API_KEY` from `~/.claude/jev.env`.
- **Configuration**: Default templates in `questions.json` merged with project-level `.claude/jev/questions.json`.
- **Skills & CLI**: Slash commands (`/jev:run`, `/jev:check`, `/jev:setup`, `/jev:on`, `/jev:off`) invoking `scripts/jev.py`.
