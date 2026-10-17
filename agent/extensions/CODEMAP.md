# agent/extensions/

## Responsibility
Middleware and extension layer for `@oh-my-pi/pi-coding-agent`. Hosts independent lifecycle extensions that monitor and guard agent execution:
- `nullform-jev.ts`: Intercepts main-session agent start (`before_agent_start`) to inject automated JEV skill recommendation hints under evaluated policy gates.
- `nullform-delete-guard.ts`: Intercepts tool execution (`tool_call`) for shell commands (`bash`, `eval`) to guard against destructive filesystem, git, and database operations in interactive sessions.

## Design Patterns
- **Plugin / Extension**: Factory functions (`createJevExtension`, `createDeleteGuardExtension`) returning lifecycle hook registration functions for `pi: ExtensionAPI`.
- **Observer / Lifecycle Hooks**: Subscribes to host lifecycle events: `before_agent_start` (JEV recommendations), `session_start` (interactivity tracking), and `tool_call` (destructive command interception).
- **Rule Engine / Interceptor**: Pattern-matching regex table (`RULES` in `nullform-delete-guard.ts`) categorizing destructive commands (`rm -r`, `git push -f`, `git reset --hard`, `git clean -f`, `find -delete`, SQL drop/truncate) paired with dynamic scope estimation (`computeRmScope`).
- **Facade / Dynamic Service Locator**: `resolveCoreModule` dynamically resolves and imports `tools/jev-assist.mjs` via `.harness-root` pointers or path fallbacks into a typed `JevCore` abstraction.
- **Specification / Gatekeeper**: Layered guards in `nullform-jev.ts` (subagent skip, opt-out files, task screening, policy fingerprint matching, model snapshot validation, confidence filtering >= 0.80) and interactive confirmation guards in `nullform-delete-guard.ts` (prompting via `ctx.ui.confirm` or `ctx.ui.ask`).

## Data & Control Flow
### JEV Assistant (`nullform-jev.ts`)
1. **Registration**: Extension registers listener on `pi.on("before_agent_start")`.
2. **Event Trigger**: Main session start provides `event.prompt` and `ctx: ExtensionContext` (subagents skipped).
3. **Validation & Resolution**: Resolves `JevCore`, extracts skills via `pi.getCommands()`, loads catalog, and verifies policy fingerprint.
4. **Evaluation**: Screens task, acquires credentials, and calls `core.decide(...)`.
5. **Output**: If model matches policy and confidence >= 0.80, appends audit event via `core.appendEvent()` and returns `{ message: { customType: "jev-skill-suggestion", ... } }`. Errors log safely without aborting.

### Delete Guard (`nullform-delete-guard.ts`)
1. **Session Setup**: On `session_start`, `handleSessionStart` evaluates `event.isInteractive`, `ctx.isInteractive`, and UI availability (`ctx.hasUI`, non-headless modes) to set interactive state.
2. **Interception Point**: On `tool_call`, `handleToolCall` intercepts tool execution for `bash` and `eval`, extracting command strings via `extractCommand`.
3. **Rule Matching & Pass-Through**: If tool is not `bash`/`eval`, command does not match `RULES`, or session is non-interactive (`!isInteractive` or `hasUI === false`), returns `undefined` (pass-through / allow under normal rules).
4. **Interactive Confirmation**: If a destructive command matches, calculates deletion scope (`computeRmScope` using `find`/`du`) and prompts user via `ctx.ui.confirm` or `ctx.ui.ask`.
5. **Decision**:
   - **Allow (Pass-Through)**: If user confirms, returns `undefined` allowing command execution.
   - **Deny (Block)**: If user cancels or dialog is dismissed, returns `DeleteGuardResult` (`{ block: true, reason: denyText, deny: denyText }`) preventing execution and returning guidance.

## Integration Points
- **Host (`@oh-my-pi/pi-coding-agent`)**: Hooks `before_agent_start`, `session_start`, `tool_call`; APIs `pi.getCommands()`, `pi.logger`, and interactive UI (`ctx.ui.confirm`, `ctx.ui.ask`).
- **Core Engine**: Dynamically imports `tools/jev-assist.mjs` implementing `JevCore` (`decide`, `screenTask`, `readPolicy`, `appendEvent`).
- **Filesystem & Environment**:
  - `nullform-jev.ts`: Discovers harness root via `.harness-root`, honors `JEV_OPTOUT`/`.jev-optout` flags, reads policy and writes telemetry events.
  - `nullform-delete-guard.ts`: Reads environment home directory (`HOME`, `USERPROFILE`) via `ctx.env` or `process.env` to expand `~` targets; executes probe commands (`find`, `du`) via `ctx.exec` to measure deletion scope.
