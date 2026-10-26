# agent/extensions/

## Responsibility
Middleware and extension layer for `@oh-my-pi/pi-coding-agent`. Hosts independent lifecycle extensions that monitor and guard agent execution:
- `nullform-jev.ts`: Intercepts main-session agent start (`before_agent_start`) to inject automated JEV skill recommendation hints under evaluated policy gates.
- `nullform-delete-guard.ts`: Intercepts tool execution (`tool_call`) for shell commands (`bash`, `eval`) to guard against destructive filesystem, git, and database operations. Requires interactive user confirmation via UI prompts, and unconditionally refuses destructive Git restorations (`git checkout`, `git restore`, `git stash`) in headless or non-interactive sessions.

## Design Patterns
- **Plugin / Extension**: Factory functions (`createDeleteGuardExtension`, `createJevExtension`) returning lifecycle hook registration functions for `pi: ExtensionAPI`. Default export functions instantiate the extensions when loaded by the host.
- **Observer / Lifecycle Hooks**: Subscribes to host lifecycle events via `pi.on`: `session_start` (interactivity tracking), `tool_call` (destructive command interception), and `before_agent_start` (JEV recommendations).
- **Rule Engine / Prioritized Interceptor**: Regex-driven detection in `nullform-delete-guard.ts` prioritizing `GIT_RESTORATION` (`blockHeadless: true`) over the standard `RULES` table (`rm -r`, `git push -f`, `git reset --hard`, `git clean -f`, `find -delete`, SQL drop/truncate), combined with filesystem deletion scope estimation (`computeRmScope`).
- **Specification / Multi-Gate Gatekeeper**: Layered policy guards in `nullform-jev.ts` (subagent screening, opt-out checks, task screening, policy fingerprint verification, model snapshot validation, confidence filtering >= 0.80) and interactive confirmation guards in `nullform-delete-guard.ts` (prompting via `ctx.ui.confirm` or `ctx.ui.ask`).
- **Dynamic Service Locator**: Dynamic import resolver (`resolveCoreModule` in `nullform-jev.ts`) that locates and binds an external runtime module matching the `JevCore` contract.

## Data & Control Flow
### Delete Guard (`nullform-delete-guard.ts`)
1. **Host Registration**: The host loads the extension through default export `createDeleteGuardExtension()`, registering handlers on `pi.on("session_start")` and `pi.on("tool_call")`.
2. **Session Interactivity Tracking**: On `session_start`, `handleSessionStart` evaluates `event.isInteractive`, `ctx.isInteractive`, and UI availability (`ctx.hasUI`, non-headless modes) to set module-level `isInteractive` state via `setInteractive`.
3. **Tool Call Interception**: On `tool_call`, `handleToolCall` intercepts execution for `bash` and `eval` tools, extracting command strings via `extractCommand` (`event.input`, `event.args`, or top-level properties). Non-shell tools return `undefined` (immediate pass-through).
4. **Command Matching**: `matchDestructiveCommand` checks the command string:
   - **Git Restoration**: `GIT_RESTORATION` tests for `git checkout`, `git restore`, or `git stash` operations across preceding global options (`-C`, `-c`, `--work-tree`, etc.). If matched, returns `blockHeadless: true`.
   - **Standard Destructive Rules**: `RULES` checks recursive directory deletion (`rm -r`/`--recursive`), remote force push (`git push -f`/`--force`), hard reset (`git reset --hard`), untracked file purge (`git clean -f`), deletion search (`find -delete`), and schema/data truncation (SQL `DROP`/`TRUNCATE`).
   - Unmatched commands return `undefined` (pass-through).
5. **Headless Gate**:
   - If session is non-interactive (`!isInteractive` or `ctx.hasUI === false`):
     - Rules with `blockHeadless: true` (`GIT_RESTORATION`) are immediately blocked without UI prompts, returning `DeleteGuardResult` (`{ block: true, reason, deny }`) directing the agent to use an isolated workspace instead.
     - Other rules pass through under standard non-interactive execution permissions.
6. **Interactive Confirmation & Scope Estimation**:
   - Resolves target user home directory from `ctx.env` or `process.env` to expand `~`.
   - For `rm` commands, `computeRmScope` calls `find` (file count) and `du` (total size) via `ctx.exec` to measure deletion scope.
   - Prompts the user interactively via `ctx.ui.confirm` or fallback `ctx.ui.ask`.
7. **Decision**:
   - **Confirmed**: User approves; returns `undefined` allowing command execution.
   - **Denied / Dismissed**: User cancels or dialog is dismissed; returns `DeleteGuardResult` (`{ block: true, reason: denyText, deny: denyText }`) with denial guidance from `buildDenyMessage`.

### JEV Assistant (`nullform-jev.ts`)
1. **Registration**: Extension registers listener on `pi.on("before_agent_start")`.
2. **Event Trigger**: Main session start provides `event.prompt` and `ctx: ExtensionContext` (subagents skipped).
3. **Validation & Resolution**: Resolves external `JevCore` implementation, extracts available skills via `pi.getCommands()`, loads catalog, and verifies policy fingerprint.
4. **Evaluation**: Screens task, acquires credentials, and calls `core.decide(...)`.
5. **Output**: If model matches policy and confidence >= 0.80, appends audit event via `core.appendEvent()` and returns `{ message: { customType: "jev-skill-suggestion", ... } }`. Errors log safely via `pi.logger` without aborting.

## Integration Points
- **Host Extension API (`@oh-my-pi/pi-coding-agent`)**:
  - Loading & Registration: Host invokes default export factories `(pi: ExtensionAPI) => void`.
  - Lifecycle Hooks: Subscribes to `session_start` and `tool_call` (in `nullform-delete-guard.ts`); `before_agent_start` (in `nullform-jev.ts`).
  - Host Capabilities: `pi.getCommands()` for command discovery, `pi.logger` for non-blocking warnings, and `ctx.ui.confirm` / `ctx.ui.ask` for interactive confirmations.
- **Subprocess & Environment**:
  - Subprocess Execution: `ctx.exec` executes `find` and `du` probes to estimate filesystem deletion scope.
  - Environment Inspection: `ctx.env` and process environment (`HOME`, `USERPROFILE`) for tilde home path expansion.
- **Core Engine Interface**:
  - Dynamic import binding against the `JevCore` contract (`readCredential`, `loadSkillCatalog`, `screenTask`, `decide`, `readPolicy`, `appendEvent`).
