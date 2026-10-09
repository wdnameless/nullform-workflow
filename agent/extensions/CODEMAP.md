# agent/extensions/

## Responsibility
Middleware / Extension layer for `@oh-my-pi/pi-coding-agent`. Intercepts main-session agent start lifecycle (`before_agent_start`) to inject automated JEV skill recommendation hints under evaluated policy gates.

## Design Patterns
- **Plugin / Extension**: Factory function `createJevExtension` returning standard `(pi: ExtensionAPI) => Promise<void>`.
- **Observer**: Subscribes to host lifecycle event `before_agent_start`.
- **Facade / Dynamic Service Locator**: `resolveCoreModule` dynamically resolves and imports `tools/jev-assist.mjs` via `.harness-root` pointers or path fallbacks into a typed `JevCore` abstraction.
- **Specification / Gatekeeper**: Layered guards for subagent skip, opt-out files, task screening, policy fingerprint matching, model snapshot validation, and confidence filtering (>= 0.80).

## Data & Control Flow
1. **Registration**: Extension registers listener on `pi.on("before_agent_start")`.
2. **Event Trigger**: Main session start provides `event.prompt` and `ctx: ExtensionContext` (subagents skipped).
3. **Validation & Resolution**: Resolves `JevCore`, extracts skills via `pi.getCommands()`, loads catalog, and verifies policy fingerprint.
4. **Evaluation**: Screens task, acquires credentials, and calls `core.decide(...)`.
5. **Output**: If model matches policy and confidence >= 0.80, appends audit event via `core.appendEvent()` and returns `{ message: { customType: "jev-skill-suggestion", ... } }`. Errors log safely without aborting.

## Integration Points
- **Host**: `@oh-my-pi/pi-coding-agent` hook `before_agent_start`, `pi.getCommands()`, and `pi.logger`.
- **Core Engine**: Dynamically imports `tools/jev-assist.mjs` implementing `JevCore` (`decide`, `screenTask`, `readPolicy`, `appendEvent`).
- **Filesystem / Environment**: Discovers root via `.harness-root`, honors `JEV_OPTOUT`/`.jev-optout` flags, reads policy and writes telemetry events.
