# video-rules-adoption — tasks

## Ready frontier (Wave 3, parallel, disjoint)

- [ ] T1. CI gates (R01+R06): шаг mutation в job `gate` (wrapper по
  changed JS-файлам, бюджет мутантов, --check) + шаг npm audit/osv
  (+semgrep если zero-config). Zone: .github/workflows/repo-gate.yml
  (+ новый tools/mutation-changed.mjs wrapper, если нужен). Owner: @fixer.
- [ ] T2. Protocol docs (R02+R03+R04+R07): QA-план в Wave 2, enrich-дамп в
  Wave 1, criticality + калибровка oracle, design-пауза перед Wave 3.
  Zone: core/PORTABLE.md, agent/agents/orchestrator.md,
  skills/nullform-workflow-full/SKILL.md, agent/agents/oracle.md.
  Owner: @sonic. Depends: T3 (точное имя pause-kind).
- [ ] T3. CLI + manifest (R04+R07+R08): `design` в WAIT_KINDS, criticality
  вне R##-таблицы (валидатор не ломать), brief.mjs в sync-manifest.json,
  тест покрытия импортов dashboard из манифеста. Zone: tools/workflow.mjs,
  tools/sync-manifest.json, tools/tests/sync-manifest-coverage.test.mjs
  (new). Owner: @fixer.
- [ ] T4. Reviewer KB (R05): границы reviewer.md — обязательные ссылки на
  CONTEXT.md + interfaces.md ченджа; вердикт без БЗ недействителен.
  Zone: agent/agents/reviewer.md. Owner: @sonic.

## Integration (parent)

- [ ] T5. Reconcile: openspec validate --strict, artifact kinds, A1–A9
  proofs, gates, commit.
- [ ] T6. Oracle vs manifest (blind) + close.
