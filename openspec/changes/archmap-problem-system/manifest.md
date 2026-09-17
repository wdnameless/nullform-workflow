# Requirements — archmap problem system + workflow weak spots (T3)

User original: «давай улучшим все наши слабые места, и карта визуальная, которая строится, она должна показывать всю архитектуру проекты должна быть минималистичная, там должны быть кнопки, которые могли бы переключать и давать возможность посмотреть граф и связку каждого отдельного файла также на русском должны описываться основные проблемы. Эти проблемы должна быть возможность скопировать одним щелчком и вставить в нейронку для того, чтобы пофигсить какие-то проблемы. Проблемы должны описываться по приоритетам от обычных критическим Это могут быть проблемы структурные, оптимизации, проблемы безопасности, неработоспособности и так далее.»
Approved via widget: «Все слабые места (T3)», «Статические эвристики», «Готовый промпт для ИИ», «Локальный граф файла», «Кластеры по папкам».

| ID | Verbatim requirement | Acceptance | Status |
|---|---|---|---|
| R01 | «показывать всю архитектуру проекта» | Full module graph for every supported-language file; folder clusters keep big repos readable; all files reachable | in-spec |
| R02 | «минималистичная» | Dark restrained UI, no decoration, graph-first | in-spec |
| R03 | «кнопки, которые могли бы переключать» | View buttons: модули / вызовы / по файлу / кластеры раскрытие; keyboard accessible | in-spec |
| R04 | «посмотреть граф и связку каждого отдельного файла» | Per-file local graph: imports + importers + its functions with call edges; back button | in-spec |
| R05 | «на русском должны описываться основные проблемы» | All problem text, categories, priorities in Russian at generation time (no post-hoc translation) | in-spec |
| R06 | «скопировать одним щелчком и вставить в нейронку» | One-click copy of a ready Russian AI prompt per problem (description, file+lines, why, suggested fix, code excerpt); clipboard fallback works from file:// | in-spec |
| R07 | «по приоритетам от обычных критическим» | Problems graded и сгруппированы по уровням (низкий/средний/высокий/критический); критические визуально выделены | in-spec |
| R08 | «структурные, оптимизации, безопасности, неработоспособности» | Categories: структура, оптимизация, безопасность, надёжность, сопровождаемость; every problem carries one | in-spec |
| R09a | weak spot «инкрементальный archmap» | Hash-based cache: unchanged files skip AST re-analysis; second full scan measurably faster | in-spec |
| R09b | weak spot «CI/CD интеграция» | Shipped GitHub Actions template: openspec validate, archmap diff comment, workflow check gate | in-spec |
| R09c | weak spot «адаптивный бюджет контекста» | workflow.mjs: per-tier budgets (T0/T1/T2), configurable, documented; no universal hardcoded quota | in-spec |
| R09d | weak spot «auto-review + self-healing» | tools/auto-review.mjs: deterministic checks (cycles, lint-if-present, typecheck-if-present, coverage note) with Russian report; suggestions, no silent auto-edits | in-spec |
| R09e | weak spot «дашборд прогресса» | Needs Paseo-native UI surface; deferred to next iteration with design doc | deferred |
| R09f | weak spot «подсказка тира» | workflow.mjs suggest: heuristic tier + confidence + reasons (no false ML claim) | in-spec |
| R09g | weak spot «автономный T0» | workflow.mjs guarded auto mode: opt-in flag, allowlist patterns, diff line cap, existing-test requirement; off by default | in-spec |
| R10 | «Статические эвристики» | No new mandatory external deps for analysis; heuristics honestly labeled | in-spec |
| R11 | «Готовый промпт для ИИ» | Prompt contains: проблема, файл:строки, почему важно, как исправить, фрагмент кода | in-spec |

Non-goals this iteration: Paseo dashboard UI (R09e deferred with reason); real ML model; SAST/semgrep; auto-editing code without review. Assumption (minor, stated): «от обычных критическим» реализуется как группировка по уровням с критическими первыми и все уровни видимы — удобство чтения важнее буквального порядка.
