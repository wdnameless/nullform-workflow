# npm-workflow-cli

## Why

Users should install the workflow like a normal npm application, select their host CLI and keep that selection through updates. Current source installation and GitHub-tag updating expose repository details and OMP-specific assumptions to other hosts.

## What changes

- A single nullform-workflow npm package exposes nullform init, doctor and update.
- init selects a harness, previews writes, configures its supported native integration and preserves user data.
- Saved installation identity directs later checks and npm-based updates.
- Runtime assets are packaged explicitly; npm installation itself does not change user configurations.
- A real packed artifact and isolated registry upgrade prove the user path.

## Non-goals

Public npmjs publishing was explicitly excluded by the user for this run. No background updater, daemon, credentials collection, automatic host/provider installation or restart.
