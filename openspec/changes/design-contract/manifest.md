# Requirements — persistent design contract + example folders + media rules

User: «давай реализуем, и я хочу чтобы все это делал наш дизайн агент» — approval of the P0+P1 list from the video analysis of «ИИ-агент дизайнит без нейрослопа»:

1. P0 «Персистентный дизайн-контракт проекта» — `docs/DESIGN.md` в проекте, читается перед каждой генерацией, обновляется после ресёрча.
2. P0 «Папки хорошо/плохо как образцы» — пример-как-спецификация.
3. P1 «Жёсткие правила генерации медиа» — никакого текста/цифр/логотипов в растре, пустое место под оверлеи, стоки до генерации.
4. P1 «Повторяющаяся ручная правка → предложи поверхность управления» — правило в AGENTS.md.

Source quotes (video, транскрипт): «бренд-кит... это просто те задания, которые агент читает перед каждой генерацией» `[01:43]`; «чем больше примеров того, как хорошо и как плохо... тем более качественные результаты» `[15:54]`; «текст не нужен никогда» на генерациях `[10:12]`; «оставлять на изображениях много пустого пространства» `[10:33]`; «медиа можно не генерировать, а искать на стоках» `[10:53]`; «просто попросить своего агента... и перетащив ползунок, изменить что-то в продукте» `[15:03]`.

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| R01 | DESIGN.md convention | `refero-design` reads `docs/DESIGN.md` when present before research; after research/lock it UPDATES it (never silently overwrites — appends/updates sections); template ships in `templates/design/DESIGN.md` | in-spec |
| R02 | Good/bad example folders | Convention `docs/examples/good/`, `docs/examples/bad/` documented in refero-design with guidance: short samples, what to steal / what to avoid; template skeletons ship in `templates/design/examples/` | in-spec |
| R03 | Hard media-generation rules | `refero-design/references/visual-workflow.md` (and design/banner skills where generation happens) gets hard rules: no raster text/digits/logos (text always vector overlay); generous negative space; stocks BEFORE generation; rules marked HARD, not advisory | in-spec |
| R04 | Control-surface rule | `agent/AGENTS.md`: repeated manual edit (same edit made twice in a session/project) → propose a tool/control surface instead of a third manual pass | in-spec |
| R05 | No quality regressions | All prompt surfaces stay valid (prompt-lint scan clean, baseline refreshed deliberately), skills-doctor healthy, 54 node tests + 7 python + verify 26/26 + audit 9/9 stay green; install/sync ship new template files | in-spec |

Non-goals: media generation tooling, stock-API integrations, Computer Use, tool-specific stacks (Magnific/Claude Design/HyperFrames), new mandatory dependencies.

Assumption (stated): DESIGN.md lives at `docs/DESIGN.md` (project documentation sibling of CONTEXT.md), examples at `docs/examples/`. Templates ship under `templates/design/`.
