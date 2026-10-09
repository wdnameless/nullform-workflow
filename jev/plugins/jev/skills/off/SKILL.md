---
name: off
description: Выключить в этом проекте роутер моделей и подсказку скилла через Jev.
disable-model-invocation: true
argument-hint: "[router | skills]"
---

Запусти `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/jev.py" off`; если пользователь написал `router` или
`skills` — добавь его в конец команды. Покажи результат одной строкой.
