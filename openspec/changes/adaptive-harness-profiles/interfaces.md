# Interfaces and ownership

## Boundary

One package; eight existing named adapters plus `custom` with a declarative host manifest. Existing OMP native review remains OMP/Bun-only. Non-OMP defaults are adaptive and avoid a forced parallel workflow. No global/user-profile apply during development.

## ProfileCore owner

Owns `tools/harness-profiles.mjs`, `tools/tests/harness-profiles.test.mjs`, `templates/host-manifest.example.json`, and the adaptive profile report integration in `tools/harness-capabilities.mjs`.

Exports from the new deep module:

- `resolveHostHome({harness,userHome,hostHome?,env?,platform?}) -> {path,source}`. Explicit hostHome wins; trusted per-host env overrides follow; Hermes honors its Windows LOCALAPPDATA/default-home suffix and safe active_profile selection. When userHome is an isolation override, unrelated real-user environment paths must not leak into it. Reject malformed/escaping profile names; do not read auth/model/env-file contents. Resolve other hosts' known env roots conservatively; uncertain conventions remain visible.
- `validateHostManifest(value, {custom=false}={}) -> normalizedManifest`. Schema1; allowed fields only: schemaVersion, id, optional displayName, instructionsFile, capabilities. Custom requires instructionsFile relative to projectRoot. Capabilities subset: taskState, delegation, worktree, terminal, browser, skills, verification, mcp. Values available/unavailable/unknown. Bounded size/strings; reject unknown keys, executable commands, absolute paths, traversal, backslashes, controls, ADS/colon destinations and reserved unsafe instruction targets. A declaration never becomes runtime proof.
- `inspectHarness({harness,userHome,hostHome?,hostManifest?,projectRoot?,env?,platform?,probe=false}) -> report`. hostManifest is a parsed object, validated at this boundary. Stable JSON: schemaVersion1, harness, profileId, hostHome/pathSource, capability evidence, modules/decision reasons, runtimeReady status and limitations. Capability evidence distinguishes documented/configured/declared/unknown; binary presence and declarations do not prove enabled tools/auth/funding. Modules state reuse/enable/manual/skip with reasons. Unknown does not trigger intrusive installs.

Default inspection spawns no host processes, starts no services and writes no files. Optional explicit Hermes probe may run only a fixed bounded allowlist (`--version`, `config path`, `tools list --platform cli`), never a shell/model turn/config dump. Probe timeouts/output limits/errors are explicit. Host/plugin bootstrap side effects cannot be universally excluded: run it only when requested and in an isolated profile during our checks. Retain only validated version/path/tool names, never free-form config/secret output. Configured evidence is not a successful task execution.

Task-state capability means durable native task management, not merely headless exec. Delegation isolation is not filesystem/worktree isolation. A browser or skills registry is not proof of a specific tool or equivalent skill. Research recommendations to inspect auth files or equate declarations with active runtime are rejected.

### Required module decisions

P01 computes these decisions; P02 installs the matching guidance/available actions; V01 exercises both branches through the public CLI. Every row includes its evidence level and an actionable reason. Documented API existence alone does not count as configured availability.

| Capability evidence | Required decision and installed action |
|---|---|
| taskState available with configured/declared evidence | reuse: use the host task tracker conditionally on its actual session availability; do not create a parallel Nullform task state or force start/check/close. Report declaration/configuration, never active execution. |
| taskState explicitly unavailable | enable: expose existing portable start/artifact/check/close commands for explicit complex coding work; installed instructions explain how to use them. General/routine requests do not acquire mandatory state. |
| delegation available with configured/declared evidence | reuse: direct dispatch to the host's existing delegation mechanism, preserving its availability/permission limits; no new agent loop. |
| delegation explicitly unavailable | manual: single-agent work or explicit operator handoff with a verifiable result/return contract; no invented callable delegation or silent omission. |
| worktree explicitly unavailable and Git present | enable: existing portable workspace/integrate commands with concrete committed-base/clean-target prerequisites. Without Git, manual action states that prerequisite; no automatic install. |
| verification explicitly unavailable or unknown | enable: lightweight actual-result verification guidance already implementable by the host/portable tools, not a new test framework or a mandatory coding spec for general tasks. Native verified/declared equivalents are reused rather than duplicated. |
| taskState/delegation/worktree unknown | manual: retain conditional native guidance and explain how to provide capability evidence or opt into portable tools; no speculative tracker/service activation. |
| terminal/browser absent or any MCP capability | manual/skip as appropriate: explain the missing prerequisite or preserve the existing host tool; never install a browser/terminal/MCP server merely to make the report look complete. |

`modules` therefore cannot be an all-skip placeholder: known available native state/delegation and explicit gap cases must produce different decisions and consumer-visible installed guidance/actions. A declaration's decisions remain visibly declaration-based, not a readiness guarantee.

## InstallerOwner

Owns `bin/nullform.mjs`, `tools/install-harness.mjs`, `tools/harness-adapters.mjs`, `tools/harness-config.mjs`, `tools/installation-state.mjs`, `tools/self-update.mjs`, `tools/doctor.mjs`, and their installer/portable-runtime test files. Reuse ProfileCore exports; no second capability/home resolver. Public CLI adds `inspect`, `--host-home`, `--host-manifest`, optional inspect-only `--probe`; custom requires a manifest and projectRoot. Existing init/doctor/update carry the selected host profile, not a newly changed environment profile.

Native home/manifest fields persisted in installation identity are normalized, bounded and validated before any write. Existing schema1 records remain readable; newly selected paths pass existing canonical confinement/journaling. Do not broaden destination authority to arbitrary manifest paths or silently import real HOME from test overrides. Standalone installation CLI/help must match the public bin.

`getMarkdownAdapter` and every non-OMP caller use the adaptive report: no forced start/check/close or dashboard for general tasks; use actual native task/delegation tools conditionally; require real output validation and truthful completion. Portable core gates/worktree CLI remain available for explicit complex coding needs. OMP strict law/native extension behavior is intentionally unchanged.

New Hermes installs: no SOUL.md write, no unsolicited mcp_servers, no bulk home-skill catalogue. Same no-new-MCP/bulk-skill default for other non-OMP adapters. Existing user MCP/skills/instructions remain untouched. Recognized Nullform-managed SOUL blocks may be removed without touching surrounding human text; remove generated legacy MCP registrations only with genuine ownership and exact-byte/value evidence, otherwise preserve and warn that legacy behavior remains. Never claim preserved legacy extras were disabled. No blind deletion of user data. Keep core package assets needed by public tools/doctor; installed bytes are not the same as active prompt load.

Hermes consumer correction verified against upstream3b2f971: home AGENTS.md is NOT a general global instruction loader; project context is discovered from cwd, while SOUL.md is identity. Use Hermes's existing `skills.auto_load` mechanism for exactly ONE generated adaptive quality skill at `<hostHome>/skills/nullform-workflow/SKILL.md`, with the normal skill frontmatter and the selected lightweight adaptive policy. Merge only its name into the existing YAML `skills.auto_load` list, preserving all human entries/comments. Validate malformed skills/auto_load types and path/skill-name collisions BEFORE mutation. Do not overwrite a human skill with the same name or re-enable an explicitly disabled skill; preserve/warn and report manual/unavailable activation instead. A single policy skill is not a bulk catalogue. Do not rely on unused home AGENTS.md as the only delivery surface.

Native loading is conditional on Hermes's skills tools and HERMES_IGNORE_RULES; report configuration/declared status, never prove runtime merely from auto_load. Explicit unavailable skills support requires a visible manual/project-instruction action, not a false enabled claim. Native delegated children can skip context/skills; the policy tells the parent to pass scoped requirements, constraints and verification criteria in native delegation context instead of pretending every child inherits the skill. Source: pinned `agent/system_prompt.py::_auto_load_parts`, `agent/skill_commands.py::resolve_auto_load_skills/build_auto_load_prompt`, `agent/prompt_builder.py::build_context_files_prompt`.

## EvidenceOwner

Owns README.md, CONTEXT.md, core/PORTABLE.md and a focused new consumer regression file `tools/tests/adaptive-harness-cli.test.mjs`. No runtime files or duplicate probe implementation. Tests run real public CLI in per-test isolated homes; no source-token assertions, wording snapshots or model inference. Document the contract example and limits without claiming generic automatic compatibility or causal quality gains. Parent runs all checks once after integration; workers skip build/lint/tests/formatters mid-flight.

## Acceptance operator (parent)

Use the retained real1.2.0 sandbox baseline and current CLI to compare registered MCP count, active managed instruction bytes, selected skill catalogue entries and elapsed deployment time. Hash/retain raw observations; label byte/context proxies and non-repeated timings, not token/invoice/performance or quality proof. Isolated profile roots must not share the live user's Hermes Kanban root. Actual Hermes CLI/session unavailable is explicit unless safely obtained and executed; fixture/source checks are not native execution.
