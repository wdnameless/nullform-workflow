# Publish + live benchmark — requirements

User ask (verbatim): "делай" — следующий рывок из прошлого итога:
"skills.sh-публикация и живой benchmark-прогон против их цифр".

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «skills.sh-публикация» | `npx skills add wdnameless/nullform-workflow --skill nullform` ставит рабочий skill: SKILL.md с корректным репо-путём, фазами Briefing/Build/Review, зеркалами .claude/.agents, skills-lock.json с SHA-256. Проверка: skills-doctor + install-симуляция в tmp. | verified |
| R02 | «живой benchmark-прогон против их цифр» | `tools/measure-session.mjs` меряет реальную сессию (роли, нормированные units, время) + `docs/benchmark-live.md` с цифрами нашего universal-1 прогона против их benchmark.md (29.4M→21.1M, 145→96 мин). Проверка: детерминированный повтор + таблица сравнения. | verified |

Scope: упаковка + замер. Out of scope: пуш в GitHub (делает пользователь),
прогон живого autopilot (нет доступа к их сессии), платные вызовы.
