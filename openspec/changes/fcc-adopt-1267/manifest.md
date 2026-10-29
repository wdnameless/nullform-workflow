# Manifest — FCC adopt 1+2+6+7

Source: user "Давай брать" + Wave 0 pick "1+2+6+7 сначала" (2026-10-28),
on T1 recon .tmp/recon-free-claude-code.md (AGPL-3.0-only: идеи да, код нет).

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | Матрица харнессов несёт версии и проверки (minVersion/args/activation), probe проверяет установленное | "Давай брать" | in-spec |
| R02 | `nullform doctor --report` выдаёт shareable JSON-бандл без секретов | "Давай брать" | in-spec |
| R03 | Словарь effort канонизирован (none/low/medium/high/xhigh/max, default medium) в CONTEXT + models.yml | "Давай брать" | in-spec |
| R04 | Факты совместимости (Hermes ≥0.20.4, MANAGED_DIR, codex catalog) закодированы в matrix со ссылкой на источник | "Давай брать" | in-spec |

## Constraints (recon facts)

- C1: AGPL-3.0-only FCC: реимплементация идей, ноль скопированных строк.
- C2: matrix loader толерантен к новым полям; menu фильтрует _comment.
- C3: doctor уже возвращает enriched JSON при --json; --report расширяет.
- C4: Опыт (general.md, Windows bash paths): single-quote + forward slashes.
- C5: openspec validate требует proposal.md + tasks.md + непустой specs/.

## Acceptance (observable)

- A1: matrix entries содержат versions/activation; probe вердиктит
  installed/version/status; schema-тест расширен.
- A2: `nullform doctor --report` печатает JSON с versions+probes, без
  токенов/ключей (негативный grep-тест на секреты).
- A3: CONTEXT содержит Effort term; models.yml.example efforts =
  [none, low, medium, high, xhigh, max], defaultLevel medium.
- A4: hermes entry: minVersion 0.20.4 + MANAGED_DIR note; codex entry:
  catalog note; оба со source-ссылкой на FCC файлы.
