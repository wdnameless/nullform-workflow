#!/usr/bin/env python3
"""Tests for tools/session_cost.py.

Deterministic unittest test suite runnable without external dependencies:
    python tools/tests/test_session_cost.py
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

# Add project root and tools to path
ROOT_DIR = Path(__file__).resolve().parent.parent.parent
TOOLS_DIR = ROOT_DIR / "tools"
FIXTURES_DIR = TOOLS_DIR / "tests" / "fixtures" / "cache"
BY_ROLE_FIXTURE = TOOLS_DIR / "tests" / "fixtures" / "by-role.jsonl"
sys.path.insert(0, str(TOOLS_DIR))

import session_cost


class TestSessionCostOriginal(unittest.TestCase):
    """Verify original selftest and baseline behavior are preserved."""

    def test_run_selftest_passes(self):
        """Original 7/7 selftest scenarios must pass without errors."""
        buf = io.StringIO()
        with redirect_stdout(buf):
            session_cost.run_selftest()
        output = buf.getvalue()
        self.assertIn("All selftest scenarios passed successfully (7/7)!", output)

    def test_baseline_parse_without_cache_report(self):
        """When cache_report is False, only per_agent, per_day, total keys exist."""
        with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
            tf.write('{"type":"message","message":{"role":"assistant","provider":"p","model":"m","timestamp":1000,"usage":{"input":10,"output":5,"totalTokens":15,"cost":{"total":0.001}}}}\n')
            tf_path = tf.name
        try:
            res = session_cost.parse_and_aggregate([tf_path], cache_report=False)
            self.assertEqual(set(res.keys()), {"per_agent", "per_day", "total"})
            self.assertNotIn("cacheReadShare", res["total"])
            self.assertNotIn("warmTurns", res["total"])
        finally:
            os.remove(tf_path)


class TestSessionCostCacheReport(unittest.TestCase):
    """Verify cache observability metrics in session_cost.py."""

    def test_cache_read_share_calculation(self):
        """Verify cacheReadShare = cacheRead / (input + cacheRead), null if denom is 0."""
        # Scenario A: warm turn with cacheRead > 0
        with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
            tf.write('{"type":"message","message":{"role":"assistant","provider":"p","model":"m","timestamp":1000,"usage":{"input":300,"output":100,"cacheRead":700,"cacheWrite":0,"totalTokens":1100,"cost":{"total":0.01}}}}\n')
            tf_path = tf.name
        try:
            res = session_cost.parse_and_aggregate([tf_path], cache_report=True)
            tot = res["total"]
            # denom = 300 + 700 = 1000, share = 700 / 1000 = 0.7
            self.assertEqual(tot["cacheReadShare"], 0.7)
            self.assertEqual(tot["warmTurns"], 1)
            self.assertEqual(tot["coldTurns"], 0)
            self.assertEqual(tot["zeroUsageTurns"], 0)
        finally:
            os.remove(tf_path)

        # Scenario B: zero denominator -> null (None)
        with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
            tf.write('{"type":"message","message":{"role":"assistant","provider":"p","model":"m","timestamp":1000,"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"total":0.0}}}}\n')
            tf_path = tf.name
        try:
            res = session_cost.parse_and_aggregate([tf_path], cache_report=True)
            tot = res["total"]
            self.assertIsNone(tot["cacheReadShare"])
            self.assertEqual(tot["zeroUsageTurns"], 1)
            self.assertEqual(tot["warmTurns"], 0)
            self.assertEqual(tot["coldTurns"], 0)
        finally:
            os.remove(tf_path)

    def test_cold_turn_and_no_infer_provider_misses(self):
        """Cold turns counted only when provider declares cache fields.

        Missing cache fields must NOT be inferred as cache misses.
        """
        # Provider with cacheRead=0 declared in usage -> cold turn
        with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
            tf.write('{"type":"message","message":{"role":"assistant","provider":"p1","model":"m1","timestamp":1000,"usage":{"input":500,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":550,"cost":{"total":0.005}}}}\n')
            tf_path1 = tf.name
        try:
            res1 = session_cost.parse_and_aggregate([tf_path1], cache_report=True)
            self.assertEqual(res1["total"]["coldTurns"], 1)
            self.assertEqual(res1["total"]["warmTurns"], 0)
            self.assertEqual(res1["total"]["cacheReadShare"], 0.0)
        finally:
            os.remove(tf_path1)

        # Provider without cache fields -> do not infer as miss
        with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
            tf.write('{"type":"message","message":{"role":"assistant","provider":"p2","model":"m2","timestamp":1000,"usage":{"input":500,"output":50,"totalTokens":550,"cost":{"total":0.005}}}}\n')
            tf_path2 = tf.name
        try:
            res2 = session_cost.parse_and_aggregate([tf_path2], cache_report=True)
            self.assertEqual(res2["total"]["coldTurns"], 0)
            self.assertEqual(res2["total"]["warmTurns"], 0)
            self.assertEqual(res2["total"]["zeroUsageTurns"], 0)
        finally:
            os.remove(tf_path2)

    def test_model_switches_and_fallback_events(self):
        """Verify model_change and fallback events update counts."""
        with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
            # Turn 1 on model-a
            tf.write('{"type":"model_change","timestamp":"2026-09-13T01:00:00Z","model":"provider/model-a","resolvedModelIsFallback":false}\n')
            tf.write('{"type":"message","message":{"role":"assistant","provider":"provider","model":"model-a","timestamp":"2026-09-13T01:00:05Z","usage":{"input":100,"output":20,"cacheRead":50,"totalTokens":170,"cost":{"total":0.001}}}}\n')
            # Switch to model-b
            tf.write('{"type":"model_change","timestamp":"2026-09-13T01:00:10Z","model":"provider/model-b","resolvedModelIsFallback":false}\n')
            tf.write('{"type":"message","message":{"role":"assistant","provider":"provider","model":"model-b","timestamp":"2026-09-13T01:00:15Z","usage":{"input":100,"output":20,"cacheRead":0,"cacheWrite":0,"totalTokens":120,"cost":{"total":0.001}}}}\n')
            # Fallback event
            tf.write('{"type":"model_change","timestamp":"2026-09-13T01:00:20Z","model":"provider/model-fb","resolvedModelIsFallback":true}\n')
            tf.write('{"type":"message","message":{"role":"assistant","provider":"provider","model":"model-fb","timestamp":"2026-09-13T01:00:25Z","usage":{"input":100,"output":20,"cacheRead":0,"cacheWrite":0,"totalTokens":120,"cost":{"total":0.001}}}}\n')
            tf_path = tf.name
        try:
            res = session_cost.parse_and_aggregate([tf_path], cache_report=True)
            tot = res["total"]
            self.assertEqual(tot["modelSwitches"], 2)
            self.assertEqual(tot["fallbackChanges"], 1)
            self.assertEqual(tot["warmTurns"], 1)
            self.assertEqual(tot["coldTurns"], 2)
            self.assertIn("per_model", res)
            self.assertIn("provider/model-a", res["per_model"])
            self.assertIn("provider/model-b", res["per_model"])
            self.assertIn("provider/model-fb", res["per_model"])
        finally:
            os.remove(tf_path)

    def test_fixtures_analysis(self):
        """Test against all fixtures in tools/tests/fixtures/cache/."""
        fixtures = [
            ("model-switch.jsonl", {"modelSwitches": 1}),
            ("fallback.jsonl", {"fallbackChanges": 1}),
            ("warm-cold.jsonl", {"warmTurns": 2, "coldTurns": 1}),
            ("unknown.jsonl", {"warmTurns": 1, "coldTurns": 1}),
            ("zero-usage-error.jsonl", {"zeroUsageTurns": 1}),
            ("compaction.jsonl", {"warmTurns": 1, "coldTurns": 1}),
            ("no-cache-provider.jsonl", {"warmTurns": 0, "coldTurns": 0}),
        ]
        for fname, expected in fixtures:
            fpath = FIXTURES_DIR / fname
            if not fpath.exists():
                continue
            res = session_cost.parse_and_aggregate([str(fpath)], cache_report=True)
            tot = res["total"]
            for key, val in expected.items():
                self.assertEqual(
                    tot[key],
                    val,
                    f"Fixture {fname} mismatch for key '{key}': expected {val}, got {tot[key]}",
                )

    def test_table_output_with_and_without_cache_report(self):
        """Table output must include cache lines when cache_report=True and omit them when False."""
        fpath = str(FIXTURES_DIR / "warm-cold.jsonl")
        if not os.path.exists(fpath):
            self.skipTest("Fixture warm-cold.jsonl not found")

        # Without cache-report
        res_plain = session_cost.parse_and_aggregate([fpath], cache_report=False)
        table_plain = session_cost.format_table(res_plain, cache_report=False)
        self.assertNotIn("cacheShare=", table_plain)
        self.assertNotIn("warm=", table_plain)

        # With cache-report
        res_cache = session_cost.parse_and_aggregate([fpath], cache_report=True)
        table_cache = session_cost.format_table(res_cache, cache_report=True)
        self.assertIn("cacheShare=", table_cache)
        self.assertIn("warm=2", table_cache)
        self.assertIn("cold=1", table_cache)


    def test_error_turn_with_tokens_is_not_zero_usage(self):
        """Regression: an errored turn that still spent tokens must classify by
        its token profile (cold/warm), not as zeroUsageTurns — the old rule
        counted it as zero-usage while still adding its tokens to the totals."""
        with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
            tf.write('{"type":"message","message":{"role":"assistant","provider":"p","model":"m","timestamp":1000,"stopReason":"error","errorStatus":429,"usage":{"input":120,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":120,"cost":{"total":0.001}}}}\n')
            tf_path = tf.name
        try:
            res = session_cost.parse_and_aggregate([tf_path], cache_report=True)
            total = res["total"]
            self.assertEqual(total["zeroUsageTurns"], 0, "errored turn with tokens must not be zero-usage")
            self.assertEqual(total["coldTurns"], 1, "it must classify as a cold turn")
            self.assertEqual(total["input"], 120, "tokens still counted in totals")
        finally:
            os.remove(tf_path)


class TestSessionCostByRole(unittest.TestCase):
    """Verify --by-role flag, role_of mapping, normalized units, and share summation."""

    def test_by_role_role_of_mapping(self):
        """role_of must match orchestrator exact first, then regex table for roles."""
        # Orchestrator exact-match first
        self.assertEqual(session_cost.role_of("orchestrator"), "orchestrator")
        self.assertEqual(session_cost.role_of("@orchestrator"), "orchestrator")
        self.assertEqual(session_cost.role_of("ORCHESTRATOR"), "orchestrator")
        self.assertEqual(session_cost.role_of("  orchestrator  "), "orchestrator")

        # Executor regex table
        self.assertEqual(session_cost.role_of("executor"), "executor")
        self.assertEqual(session_cost.role_of("fixer"), "executor")
        self.assertEqual(session_cost.role_of("designer"), "executor")
        self.assertEqual(session_cost.role_of("explorer"), "executor")
        self.assertEqual(session_cost.role_of("librarian"), "executor")
        self.assertEqual(session_cost.role_of("sonic"), "executor")
        self.assertEqual(session_cost.role_of("writer-1"), "executor")
        self.assertEqual(session_cost.role_of("worker_subagent"), "executor")
        self.assertEqual(session_cost.role_of("task"), "executor")
        self.assertEqual(session_cost.role_of("scout"), "executor")

        # Reviewer regex table
        self.assertEqual(session_cost.role_of("reviewer"), "reviewer")
        self.assertEqual(session_cost.role_of("security-reviewer"), "reviewer")
        self.assertEqual(session_cost.role_of("code-review"), "reviewer")

        # Oracle regex table
        self.assertEqual(session_cost.role_of("oracle"), "oracle")
        self.assertEqual(session_cost.role_of("OracleU19"), "oracle")
        self.assertEqual(session_cost.role_of("acceptance-tester"), "oracle")
        self.assertEqual(session_cost.role_of("blind-verifier"), "oracle")

        # Other / fallback
        self.assertEqual(session_cost.role_of("unknown"), "other")
        self.assertEqual(session_cost.role_of("anthropic/claude-3-5-sonnet"), "other")
        self.assertEqual(session_cost.role_of(""), "other")
        self.assertEqual(session_cost.role_of(None), "other")

    def test_by_role_fixture_grouping_and_shares(self):
        """Grouping on synthetic fixture must calculate correct units and shares summing to total."""
        self.assertTrue(BY_ROLE_FIXTURE.exists(), f"Fixture {BY_ROLE_FIXTURE} must exist")
        res = session_cost.parse_and_aggregate([str(BY_ROLE_FIXTURE)], by_role=True)

        self.assertIn("per_role", res)
        per_role = res["per_role"]
        self.assertEqual(set(per_role.keys()), {"orchestrator", "executor", "reviewer", "oracle"})

        # Orchestrator: 50 out * 5 + 100 cw * 1.25 + 250 cr * 0.1 = 250 + 125 + 25 = 400.0
        orch = per_role["orchestrator"]
        self.assertEqual(orch["steps"], 1)
        self.assertEqual(orch["normalizedUnits"], 400.0)

        # Executor: 2 turns (fixer: 150 out, 200 cw, 500 cr; executor: 100 out, 100 cw, 250 cr)
        # total exec: 250 out * 5 + 300 cw * 1.25 + 750 cr * 0.1 = 1250 + 375 + 75 = 1700.0
        exec_role = per_role["executor"]
        self.assertEqual(exec_role["steps"], 2)
        self.assertEqual(exec_role["normalizedUnits"], 1700.0)

        # Reviewer: 40 out * 5 + 50 cw * 1.25 + 75 cr * 0.1 = 200 + 62.5 + 7.5 = 270.0
        rev = per_role["reviewer"]
        self.assertEqual(rev["steps"], 1)
        self.assertEqual(rev["normalizedUnits"], 270.0)

        # Oracle: 20 out * 5 + 20 cw * 1.25 + 50 cr * 0.1 = 100 + 25 + 5 = 130.0
        ora = per_role["oracle"]
        self.assertEqual(ora["steps"], 1)
        self.assertEqual(ora["normalizedUnits"], 130.0)

        # Sum of role normalized units must equal total normalized units
        total_units = res["total"]["normalizedUnits"]
        self.assertEqual(total_units, 2500.0)
        self.assertEqual(sum(r["normalizedUnits"] for r in per_role.values()), total_units)

        # Shares must sum to 1.0 (100%)
        shares_sum = sum(r["share"] for r in per_role.values())
        self.assertAlmostEqual(shares_sum, 1.0, places=4)
        self.assertAlmostEqual(sum(r["sharePercent"] for r in per_role.values()), 100.0, places=1)

    def test_by_role_default_output_byte_identical(self):
        """When --by-role is not passed, output is byte-identical and per_role key is omitted."""
        res_default = session_cost.parse_and_aggregate([str(BY_ROLE_FIXTURE)], by_role=False)
        res_unspecified = session_cost.parse_and_aggregate([str(BY_ROLE_FIXTURE)])
        self.assertEqual(res_default, res_unspecified)
        self.assertNotIn("per_role", res_default)
        self.assertNotIn("normalizedUnits", res_default["total"])

        table_default = session_cost.format_table(res_default, by_role=False)
        self.assertNotIn("=== PER ROLE ===", table_default)

        res_role = session_cost.parse_and_aggregate([str(BY_ROLE_FIXTURE)], by_role=True)
        table_role = session_cost.format_table(res_role, by_role=True)
        self.assertIn("=== PER ROLE ===", table_role)
        self.assertIn("steps=1", table_role)
        self.assertIn("units=    1,700.00", table_role)
        self.assertIn("share=  68.0%", table_role)

        # Total line must be identical
        total_line = "TOTAL: in=580 out=360 total=940 (cacheR=1,125 cacheW=470) | cost=$0.0350"
        self.assertIn(total_line, table_default)
        self.assertIn(total_line, table_role)

    def test_by_role_cli_invocation(self):
        """CLI with --by-role prints the per-role table to stdout."""
        buf = io.StringIO()
        orig_argv = sys.argv
        try:
            sys.argv = ["session_cost.py", "--by-role", str(BY_ROLE_FIXTURE)]
            with redirect_stdout(buf):
                session_cost.main()
            output = buf.getvalue()
            self.assertIn("=== PER ROLE ===", output)
            self.assertIn("orchestrator", output)
            self.assertIn("executor", output)
            self.assertIn("reviewer", output)
            self.assertIn("oracle", output)
        finally:
            sys.argv = orig_argv

if __name__ == "__main__":
    unittest.main()
