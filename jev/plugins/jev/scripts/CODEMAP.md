# jev/plugins/jev/scripts/

## Responsibility
CLI toolchain, evaluation harness, and client Facade for the Jev classification and routing subsystem. Provides administrative and batch evaluation commands (`jev.py`) alongside transport, credentials resolution, skill discovery, and transcript analysis routines (`jev_client.py`).

## Design Patterns
- **Facade / Gateway**: `jev_client.py` wraps remote LLM/eval APIs (TypeSafe, OpenRouter) and filesystem interactions behind unified functional APIs.
- **Command**: `jev.py` dispatches CLI subcommands (`setup`, `on`, `off`, `run`, `check`) via `argparse` action handlers.
- **Repository / DAO**: Abstracted JSON/JSONL serialization for plugin configs, session caches, and runtime state.
- **Thread-Local Connection Pooling**: `threading.local` maintains reusable HTTP(S) connections across concurrent evaluation workers.

## Data & Control Flow
- **CLI Commands**: `main()` routes invocations to subcommand handlers (`cmd_setup`, `cmd_toggle`, `cmd_run`, `cmd_check`).
- **Batch Evaluation (`run`)**: `read_records()` ingests CSV/JSONL dataset -> `build_state()` filters fields -> `ThreadPoolExecutor` invokes `jc.ask()` in parallel -> responses formatted and saved to output file.
- **Ground-Truth Benchmark (`check`)**: Ingests labeled datasets -> `normalize()` standardizes human vs model outputs -> compares predictions against ground truth and outputs accuracy tables.
- **Network Dispatch**: `ask()` issues TLS/HTTP requests with auth tokens and proxy awareness, parses structured JSON, and returns usage/cost calculations.

## Integration Points
- **External Endpoints**: TypeSafe AI (`https://api.typesafe.ai`), OpenRouter (`https://openrouter.ai/api`).
- **Hook Integration**: Consumed by hook script `jev/plugins/jev/hooks/before_prompt.py`.
- **Filesystem Contracts**: Credential files (`~/.claude/jev.env`), project state (`.claude/jev/state.json`), task definitions (`.claude/jev/questions.json`), audit logs (`.claude/jev/log.jsonl`), skill manifests (`.claude/skills/*/SKILL.md`).
- **Exceptions & Types**: `JevError` signals network/auth failures; question schemas define scoring criteria.
