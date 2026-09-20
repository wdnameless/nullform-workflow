# Requirements — context pipeline + oracle model autoselect (T2)

User: «давай это сделаем и придумаем пайплайн подачи контекста в задачу, то есть, чтобы модель подсказывала, например, пользователю, что ей не хватает контекста, и пусть он поместит контекст... относительно дизайн, архитектуры, еще чего-то в определенную папку, чтобы она могла читать... И модель для Оракла давай автоматически выбирать самую сильную если она недоступна, то будем возвращаться фуллбэком на gemini 3.8 flash high».
Video-analysis P0/P1 (approved earlier): domain-context, media-context skill, human-plan rule, Ponytail lens, oracle different-model note.

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| R01 | Context intake pipeline | `context/` folder convention with categories design/architecture/domain/product/ops/other; `tools/context-inbox.mjs` init/request/list/resolve/check; REQUESTS.md machine-readable table; agent rule: missing context → record request + tell user where to drop, proceed with stated assumptions, never block | in-spec |
| R02 | Domain-context collector | `tools/domain-context.mjs --domain X`: bounded summary from repo files (codemap/path heuristics), recent git commits, related GitHub issues via `gh` when available; graceful degradation everywhere; no network beyond optional `gh` | in-spec |
| R03 | Media-context skill | `skills/media-context/SKILL.md`: transcript pipeline (yt-dlp → faster-whisper; fallbacks), outputs to context/, privacy note (local), exact commands | in-spec |
| R04 | Human-plan rule | proposal/plan in T2 SHALL be human-readable without implementation details; details live in interfaces.md/tasks.md (orchestrator Wave 2) | in-spec |
| R05 | Ponytail lens | reviewer.md gains a mandatory "simplest solution" lens (anti over-engineering, DRY) | in-spec |
| R06 | Oracle model autoselect | `tools/oracle-model.mjs` list/ensure/apply; priority file `agent/oracle-priority.example.json`; resolution = first priority match among available models (declared in models.yml; `--probe` also enumerates discovery providers via /models); fallback entry `gemini-3.8-flash-high`; writes modelRoles.oracle + task.agentModelOverrides.oracle in config.yml via targeted line replace preserving all else; never prints secrets | in-spec |
| R07 | Oracle ensure wiring | install.ps1 runs apply best-effort after config.yml; orchestrator Wave 4 runs `ensure` before spawning oracle; audit.ps1 reports oracle resolution (advisory) | in-spec |
| R08 | No regressions | 54 node + 8 py + 11 portability + verify 26/26 + audit 9/9 stay green (audit may grow); prompt baseline refreshed deliberately; sync ships new tools/templates | in-spec |

Non-goals: automatic context fetching from the internet; tracker API keys; changing model routing for other roles; Paseo.

Assumptions (stated): folder `context/` at project root; tool names as above; priority list user-editable with sane defaults; network only in `--probe`.
