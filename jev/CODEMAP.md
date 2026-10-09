# jev/

## Responsibility
Plugin Distribution Root and Marketplace Catalog. Acts as the distribution bundle and local plugin registry for Claude Code plugins (specifically the `nick-vels` marketplace housing `jev`), packaging installation guides, licensing, and plugin payloads.

## Design Patterns
- **Registry / Marketplace Catalog**: `.claude-plugin/marketplace.json` defines plugin metadata and points to package sources (`./plugins/jev`).
- **Distribution Bundle**: Self-contained distributable archive root containing user documentation (`инструкция.md`), license, and plugin trees.
- **Hierarchical Delegation**: Acts as an umbrella root delegating runtime logic, skills, hooks, and scripts to nested plugin packages in `plugins/`.

## Data & Control Flow
1. **Catalog Registration**: Claude Code runs `claude plugin marketplace add <path>`, parsing `.claude-plugin/marketplace.json` to index available plugins.
2. **Plugin Resolution**: `claude plugin install jev@nick-vels` resolves the `jev` plugin entry and mounts `plugins/jev`.
3. **Execution Routing**: User commands (`/jev:setup`, `/jev:on`, `/jev:run`) and lifecycle hooks resolve to underlying scripts in `plugins/jev/`.

## Integration Points
- **Claude Code Marketplace CLI**: Consumed by `claude plugin marketplace (add|remove)` and `claude plugin (install|update)`.
- **Manifest References**: `.claude-plugin/marketplace.json` binds the marketplace name (`nick-vels`) to relative plugin source `./plugins/jev`.
- **Nested Packages**: Exports and delegates to the `jev` plugin package in `plugins/jev/`.
