# Oracle verdict: eval-metrics R01–R03 (release v1.0.0)

Verdict: ACCEPT

R01 proven: pass@k/pass^k, живой зонд 75/25, 26/26 тестов (oracle-r01.md).
R02 proven: 10 задач, smoke red exit 1 / green exit 0, CI-джоба, 30/30 (oracle-r02.md).
R03 proven: record→hit байт-в-байт, strict-miss exit 1, verify secrets, --replay $0, 8/8 + 33/33 (oracle PassKOracle/LmReplayOracle).
R04 open: калибровка oracle (каппа) требует разметки 20–30 сессий человеком — следующий заход.
Release v1.0.0 создан; self-update check → clean; doctor release-drift → PASS.
