/**
 * tools/tests/dashboard-autoreview.test.mjs — Регресс на ветвление строки
 * auto-review в HTML-дашборде: `unverified` не должен называться провалом.
 */
delete process.env.PASEO_AGENT_ID;
delete process.env.OMP_SESSION_ID;

import test from "node:test";
import assert from "node:assert/strict";

import { generateDashboardHtml } from "../dashboard.mjs";

test("dashboard: auto-review unverified не выдаёт себя за провал (регресс на ar.ok)", () => {
  const html = generateDashboardHtml({ project: { name: "x" }, task: { title: "t", tier: "T1", status: "open" }, git: { isRepo: false, files: [] }, progress: { percent: 0, stagesDone: 0, stagesRequired: 1, stagesSkipped: 0, artifactsDone: 0, artifactsTotal: 1 }, stages: [], waves: [], currentStage: {}, timing: {}, history: { recent: [], byTier: {} }, critique: [], fleet: [], metrics: { briefCoverage: 0, requirements: { total: 0, byStatus: {}, items: [] }, debt: { total: 0, items: [] }, memory: {}, checks: { autoReview: { status: "unverified", ok: false, total: 0 } } } });
  const m = html.match(/auto-review: ' \+ \(ar\.error \? esc\(ar\.error\) : ([^;]+)\) \+ "<\/div>"/);
  assert.ok(m, "строка критики рендерится из ветвления по ar.status");
  const branch = new Function("ar", "esc", "return (" + m[1] + ");");
  for (const [ar, want] of [[{ status: "unverified", ok: false, total: 0 }, "не подтверждено"], [{ status: "pass", ok: true, total: 0 }, "пройдено, проблем 0"], [{ status: "fail", ok: false, total: 3 }, "провалено, проблем 3"]]) assert.equal(branch(ar, String), want);
  assert.ok(!branch({ status: "unverified", ok: false, total: 0 }, String).includes("провалено"), "unverified не называется провалом");
});
