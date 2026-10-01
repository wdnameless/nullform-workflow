---
name: on
description: Включить в этом проекте роутер моделей и подсказку скилла через Jev.
disable-model-invocation: true
argument-hint: "[router | skills]"
---

Запусти `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/jev.py" on`; если пользователь написал `router` или
`skills` — добавь его в конец команды. Покажи результат одной строкой и добавь: подсказки появятся
со следующего сообщения, проверить — `/jev:setup`.
