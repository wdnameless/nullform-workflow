# Requirements — original brief and approved choices

User original: «Визуальная структура, хочу чтобы ты сделал темную боль для минималистичную, чтобы данные выводились на русском, и была возможность открыть полную визуальную архитектуру проекта и посмотреть граф, какие функции модули с чем связаны и так далее. Также есть вопрос по поводу посел плюс ОМП какую роль в Workflow играет PoSEO? Какую Омп. Я хочу, чтобы на ОМП был основной каркас workflow, а посео просто немного дополнял его сверху, то есть, чтобы юзер, который скачает наш воркфлоу, он не зависел от посео, он зависел именно от ОМП. Желательно вообще чтобы наш вокрфлоу был харнесс и модел агностик»
Prior constraints: «Но удобство от paseo останется ?»; «если это не повлияет на наш воркфлоу и ничего не испортит и не поломает».
Approved choices: «Переносимое ядро, OMP основной» and «JS/TS — глубокий анализ».

| ID | Verbatim requirement | Acceptance | Status |
|---|---|---|---|
| R01 | «темную … минималистичную» | Restrained dark offline architecture report, readable on desktop/mobile | in-spec |
| R02 | «данные выводились на русском» | All user-facing report labels, findings, kinds and limitations Russian; code identifiers unchanged | in-spec |
| R03 | «открыть полную визуальную архитектуру проекта» | Fullscreen/expanded graph, search, fit/reset, pan/zoom, all indexed modules reachable | in-spec |
| R04 | «какие функции модули с чем связаны»; «JS/TS — глубокий анализ» | AST-based JS/TS symbols plus statically resolved call edges, caller/callee navigation, aliases/reexports/methods; unresolved dynamic calls explicitly reported, never guessed | in-spec |
| R05 | «какую роль … PoSEO? Какую Омп» | Explain protocol vs executor vs optional environment supervisor accurately in Russian | in-spec |
| R06 | «на ОМП был основной каркас workflow» | Existing OMP roles, tools, installer path remain usable | in-spec |
| R07 | «он не зависел от посео» | No mandatory Paseo in core execution/process/worktree paths, base install does not touch Paseo profile or invoke daemon | in-spec |
| R08 | «Но удобство от paseo останется ?» | Preserve optional explicit Paseo integration, profile/user settings, templates, supervised services instructions | in-spec |
| R09 | «харнесс и модел агностик»; «Переносимое ядро, OMP основной» | Portable protocol/CLI independent of OMP APIs; OMP bindings separate; no universal hardcoded model/provider quota; other harness support not falsely advertised as verified | in-spec |
| R10 | «ничего не испортит и не поломает» | Existing commands and verification retained, installation tested in sandbox, existing real credentials/config not rewritten; honest limitations | in-spec |

Non-goals: verified adapter for a second harness; perfect dynamic dispatch/runtime call graph; deep call graphs outside JS/TS. Existing language overview retained with explicit coverage. Do not remove current user's Paseo setup. Existing staged archmap change is prior work to complete, not discard.
