# Primary sources and evidence limits

Research is source/documentation inspection, not a live client/model acceptance run. Retrieved during this change; changing upstream main branches are not compatibility version guarantees.

| Source | Verified observation | Consequence for Nullform |
|---|---|---|
| https://www.anthropic.com/engineering/building-effective-agents | Prefer simple composable patterns; increase agent complexity only when outcomes justify it; tool interfaces and actual environment feedback matter. Original2024 article explicitly links newer tooling guidance. | No new agent loop/framework/task board. Deterministic checks enforce concrete invariants; do not claim this article proves our quality uplift. |
| https://code.claude.com/docs/en/memory | CLAUDE.md user/project scope; concise consistent context; long procedures belong in skills/path rules. Imports do not reduce context cost. Instructions are context, not enforced security configuration. | Small managed policy, native discovery/load scope, on-demand strict procedures, preserve human context. No 'prompt equals sandbox' claim. |
| https://developers.openai.com/codex/guides/agents-md/ | Codex home and root-to-cwd AGENTS chain; AGENTS.override.md wins at each level; first nonempty file per directory; byte limit applies. Redirect currently resolves to learn.chatgpt.com/docs/agent-configuration/agents-md. | Do not overwrite human overrides or silently claim a shadowed instruction loaded. No duplicate task tracker or full skill import. |
| https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/cli.md | Current CLI is gateway-backed; native delegation, worktrees, resumable sessions and explicit skill preload already exist. Behavior differs from previously inspected0.19. | Reuse those native features. Existing0.19 agent.system_prompt consumption evidence is version-scoped; no invented universal skills.auto_load contract. |
| https://docs.openclaw.ai/concepts/agent-workspace | Explicit agents.entries.<id>.workspace; native workspace AGENTS/SOUL/USER; cwd is not a sandbox; bootstrap files and optional skills have distinct purposes. | Existing entries.workflow workspace mapping is supported. Add workflow guidance without replacing persona or claiming filesystem isolation. |
| https://raw.githubusercontent.com/tinyhumansai/openhuman/main/README.md | Product identity is tinyhumansai/openhuman (Rust/library/desktop), not OpenHands. Native tools, workflows, MCP, skills, memory and approvals already exist; README performance claims are upstream's measurements, not ours. | Do not recreate native engines or repeat their benchmark claims as Nullform evidence. |
| https://raw.githubusercontent.com/tinyhumansai/openhuman/a4550c5398a4dabfe51208046e97995059d521ff/.gitmodules | Current runtime implementation is split into vendor/tinyagents, vendor/tinyskills and other tinyhumansai repositories. Root contributor AGENTS.md does not prove runtime loading. | OpenHuman AGENTS loader remains unverified until actual consumer source is inspected; report manual/unknown instead of guessed automatic compatibility. |
| https://dev.opencode.ai/v2/docs/instructions/ | Research worker identified native project/home AGENTS guidance. | Preserve native instruction scope; doc-backed, not live-session proof. |
| https://docs.cursor.com/context/rules | Research worker identified project .cursor/rules/*.mdc; old .cursorrules deprecated. | Use project-native rules rather than home identity rewriting. |

OMP uses its installed native instruction/delegation/approval mechanisms. Our shipped policies and optional CLI can supplement them; installing our package is not evidence of actual task execution or quality improvement.

## Executed baseline observations

Parent audit before this change exercised six defects locally on29f7185: failed consumer exit23 still projected HTTP ACCEPT; more than256 retained directories allowed second ordinary runner invocation; valid ledger1048102 bytes grew to1048602 and settlement exceeded1048576 read ceiling; explicit redo after publication failure refused while recommending redo; no-policy dry-run exit1 with invalid-schema error; valid-policy dry-run with unexpected positional returned exit0. Synthetic native replies were transition fixtures; HTTP oracle probe used only127.0.0.1 and dummy auth. No external provider request was made during this audit.

## Public claims boundary

Can prove: exact command behavior, prevented errors, deterministic transition safety, human-byte preservation, source/provenance validation, reproducible package contents and byte/line footprint. Cannot infer: improved model-generated-code quality, token/bill savings, universal client loading, benchmark leadership or superiority over all workflows. No new paid A/B authorized.
