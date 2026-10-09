# jev/plugins/

## Responsibility
Thin plugin container and namespace root acting as a Plugin Registry / Distribution layer. Holds no executable runtime code; serves to organize plugin packages and point consumers to the real payload package in `jev/plugins/jev/`.

## Design Patterns
- **Plugin Registry / Package Directory**: Groups installable plugin packages under a uniform namespace referenced by marketplace discovery.
- **Delegation / Namespace Facade**: Structural boundary delegating all execution, hooks, skills, and scripts down into individual plugin payloads (`jev/`).

## Data & Control Flow
- Registration: The marketplace manifest (`jev/.claude-plugin/marketplace.json`) defines plugin discovery paths targeting packages in this directory (`./plugins/jev`).
- Traversal: Claude Code runtime resolves plugin roots and directly enters payload subdirectories without processing data at this container level.
- Control transfer: All lifecycle events and hook invocations bypass this directory, executing directly within `jev/plugins/jev/`.

## Integration Points
- **Marketplace Manifest**: Referenced by `jev/.claude-plugin/marketplace.json` via plugin source declarations.
- **Plugin Payloads**: Houses `jev/plugins/jev/` (hooks, scripts, skills, and plugin manifest).
- **Consumer**: Claude Code plugin manager and installer mechanisms.
