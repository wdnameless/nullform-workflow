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


if __name__ == "__main__":
    unittest.main()
