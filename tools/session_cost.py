#!/usr/bin/env python3
"""Session Cost aggregation CLI tool.

Parses .jsonl transcript files, aggregates token usage and costs per provider/model
agent, per UTC day, and grand total.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import json
import os
import sys
import tempfile
from typing import Any, Dict, List, Optional, Tuple, Union


def parse_timestamp_to_utc_date(ts: Union[int, float, str, None]) -> str:
    """Convert epoch seconds, milliseconds, or ISO string to UTC date YYYY-MM-DD."""
    if ts is None:
        return "unknown"

    if isinstance(ts, (int, float)):
        # If timestamp is likely in milliseconds (> 1e11), convert to seconds
        val = float(ts)
        if val > 1e11:
            val = val / 1000.0
        try:
            dt = datetime.fromtimestamp(val, tz=timezone.utc)
            return dt.strftime("%Y-%m-%d")
        except Exception:
            return "unknown"

    if isinstance(ts, str):
        # Try numeric parse first
        try:
            val = float(ts)
            if val > 1e11:
                val = val / 1000.0
            dt = datetime.fromtimestamp(val, tz=timezone.utc)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            pass

        # Try ISO format
        cleaned = ts.replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(cleaned)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            else:
                dt = dt.astimezone(timezone.utc)
            return dt.strftime("%Y-%m-%d")
        except Exception:
            # Fallback string prefix YYYY-MM-DD if present
            if len(ts) >= 10 and ts[4] == "-" and ts[7] == "-":
                return ts[:10]
            return "unknown"

    return "unknown"


def empty_metrics() -> Dict[str, Any]:
    return {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "cost": defaultdict(float),
        "warmTurns": 0,
        "coldTurns": 0,
        "zeroUsageTurns": 0,
        "modelSwitches": 0,
        "fallbackChanges": 0,
    }


def add_metrics(dest: Dict[str, Any], usage: Dict[str, Any]) -> None:
    for field in ("input", "output", "cacheRead", "cacheWrite"):
        val = usage.get(field, 0)
        if isinstance(val, (int, float)):
            dest[field] += int(val)

    if "totalTokens" in usage and isinstance(usage["totalTokens"], (int, float)):
        dest["totalTokens"] += int(usage["totalTokens"])
    else:
        # Fallback to sum of tokens if totalTokens is absent
        pass

    cost_obj = usage.get("cost")
    if isinstance(cost_obj, dict):
        for k, v in cost_obj.items():
            if isinstance(v, (int, float)):
                dest["cost"][k] += float(v)
    elif isinstance(cost_obj, (int, float)):
        dest["cost"]["total"] += float(cost_obj)


def metrics_to_dict(metrics: Dict[str, Any], include_cache_report: bool = False) -> Dict[str, Any]:
    # Convert cost defaultdict to regular dict, rounded for clean representation if needed
    cost_dict = dict(metrics["cost"])
    # If total was not explicitly provided but other cost fields exist, ensure total
    if "total" not in cost_dict and cost_dict:
        cost_dict["total"] = sum(cost_dict.values())
    elif not cost_dict:
        cost_dict = {"total": 0.0}

    # Clean float display
    clean_cost = {}
    for k, v in cost_dict.items():
        clean_cost[k] = round(v, 6) if isinstance(v, float) else v

    out = {
        "input": metrics["input"],
        "output": metrics["output"],
        "cacheRead": metrics["cacheRead"],
        "cacheWrite": metrics["cacheWrite"],
        "totalTokens": metrics["totalTokens"],
        "cost": clean_cost,
    }

    if include_cache_report:
        inp = metrics["input"]
        cr = metrics["cacheRead"]
        denom = inp + cr
        share = round(cr / denom, 4) if denom > 0 else None
        out["cacheReadShare"] = share
        out["warmTurns"] = metrics.get("warmTurns", 0)
        out["coldTurns"] = metrics.get("coldTurns", 0)
        out["zeroUsageTurns"] = metrics.get("zeroUsageTurns", 0)
        out["modelSwitches"] = metrics.get("modelSwitches", 0)
        out["fallbackChanges"] = metrics.get("fallbackChanges", 0)

    return out


def parse_and_aggregate(
    paths: List[str],
    cache_report: bool = False,
    include_cache_report: bool = False,
) -> Dict[str, Any]:
    do_cache = cache_report or include_cache_report
    per_agent: Dict[str, Dict[str, Any]] = defaultdict(empty_metrics)
    per_day: Dict[str, Dict[str, Any]] = defaultdict(empty_metrics)
    total_metrics = empty_metrics()

    for path in paths:
        if not os.path.exists(path):
            continue
        try:
            current_model: Optional[str] = None
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except Exception:
                        continue

                    if not isinstance(event, dict):
                        continue

                    event_type = event.get("type")

                    # Parse model_change events
                    if event_type == "model_change":
                        raw_model = event.get("model") or event.get("to")
                        prov = event.get("provider")
                        if prov and raw_model and "/" not in raw_model:
                            model_key = f"{prov}/{raw_model}"
                        elif raw_model:
                            model_key = raw_model
                        else:
                            model_key = current_model or "unknown"

                        ts = event.get("timestamp")
                        day_key = parse_timestamp_to_utc_date(ts)

                        is_fallback = bool(
                            event.get("resolvedModelIsFallback")
                            or event.get("isFallback")
                            or event.get("fallback")
                        )
                        if is_fallback:
                            per_agent[model_key]["fallbackChanges"] += 1
                            per_day[day_key]["fallbackChanges"] += 1
                            total_metrics["fallbackChanges"] += 1

                        prev = event.get("from") or current_model
                        if prev is not None and raw_model and raw_model != prev:
                            per_agent[model_key]["modelSwitches"] += 1
                            per_day[day_key]["modelSwitches"] += 1
                            total_metrics["modelSwitches"] += 1
                        elif current_model is None and event.get("from") is not None:
                            per_agent[model_key]["modelSwitches"] += 1
                            per_day[day_key]["modelSwitches"] += 1
                            total_metrics["modelSwitches"] += 1

                        if raw_model:
                            current_model = raw_model
                        continue

                    # Parse fallback events
                    if event_type == "fallback":
                        raw_model = event.get("model") or current_model or "unknown"
                        prov = event.get("provider")
                        if prov and raw_model and "/" not in raw_model:
                            model_key = f"{prov}/{raw_model}"
                        else:
                            model_key = raw_model

                        ts = event.get("timestamp")
                        day_key = parse_timestamp_to_utc_date(ts)

                        per_agent[model_key]["fallbackChanges"] += 1
                        per_day[day_key]["fallbackChanges"] += 1
                        total_metrics["fallbackChanges"] += 1

                        if event.get("model") and current_model is not None and event.get("model") != current_model:
                            per_agent[model_key]["modelSwitches"] += 1
                            per_day[day_key]["modelSwitches"] += 1
                            total_metrics["modelSwitches"] += 1
                            current_model = event.get("model")
                        continue

                    if event_type != "message":
                        continue

                    msg = event.get("message")
                    if not isinstance(msg, dict):
                        continue
                    if msg.get("role") != "assistant":
                        continue

                    usage = msg.get("usage")
                    if not isinstance(usage, dict):
                        continue

                    # Numeric input and output required per spec
                    if "input" not in usage or not isinstance(usage["input"], (int, float)):
                        continue
                    if "output" not in usage or not isinstance(usage["output"], (int, float)):
                        continue

                    provider = msg.get("provider") or event.get("provider") or "unknown"
                    model = msg.get("model") or event.get("model") or "unknown"
                    agent_key = f"{provider}/{model}"

                    if current_model is None:
                        current_model = agent_key

                    # Timestamp can be on message or top-level event
                    ts = msg.get("timestamp")
                    if ts is None:
                        ts = event.get("timestamp")
                    day_key = parse_timestamp_to_utc_date(ts)

                    if msg.get("resolvedModelIsFallback") is True or msg.get("isFallback") is True or msg.get("fallback") is True:
                        per_agent[agent_key]["fallbackChanges"] += 1
                        per_day[day_key]["fallbackChanges"] += 1
                        total_metrics["fallbackChanges"] += 1

                    # Total tokens auto-compute if omitted
                    u_copy = dict(usage)
                    if "totalTokens" not in u_copy:
                        u_copy["totalTokens"] = int(u_copy.get("input", 0)) + int(u_copy.get("output", 0))

                    inp_val = int(u_copy.get("input", 0))
                    out_val = int(u_copy.get("output", 0))
                    cr_val = int(u_copy.get("cacheRead", 0))

                    has_cache_field = "cacheRead" in usage or "cacheWrite" in usage
                    # Classification by actual token usage: an errored turn that
                    # still spent tokens is a real (cold/warm) turn, not zero-usage.
                    # Mixing both made zeroUsageTurns overlap the token totals.
                    is_zero_usage = (inp_val == 0 and out_val == 0 and cr_val == 0)
                    is_warm = cr_val > 0
                    is_cold = has_cache_field and (inp_val > 0 and cr_val == 0)

                    if is_zero_usage:
                        per_agent[agent_key]["zeroUsageTurns"] += 1
                        per_day[day_key]["zeroUsageTurns"] += 1
                        total_metrics["zeroUsageTurns"] += 1
                    elif is_warm:
                        per_agent[agent_key]["warmTurns"] += 1
                        per_day[day_key]["warmTurns"] += 1
                        total_metrics["warmTurns"] += 1
                    elif is_cold:
                        per_agent[agent_key]["coldTurns"] += 1
                        per_day[day_key]["coldTurns"] += 1
                        total_metrics["coldTurns"] += 1

                    add_metrics(per_agent[agent_key], u_copy)
                    add_metrics(per_day[day_key], u_copy)
                    add_metrics(total_metrics, u_copy)
        except Exception:
            continue

    out_per_agent = {k: metrics_to_dict(v, do_cache) for k, v in sorted(per_agent.items())}
    out_per_day = {k: metrics_to_dict(v, do_cache) for k, v in sorted(per_day.items())}
    out_total = metrics_to_dict(total_metrics, do_cache)

    result = {
        "per_agent": out_per_agent,
        "per_day": out_per_day,
        "total": out_total,
    }
    if do_cache:
        result["per_model"] = out_per_agent

    return result


def format_table(data: Dict[str, Any], cache_report: bool = False) -> str:
    lines: List[str] = []

    def format_row(name: str, m: Dict[str, Any], width: int = 30) -> str:
        tokens_str = f"in={m['input']:,} out={m['output']:,} total={m['totalTokens']:,}"
        if m.get("cacheRead", 0) > 0 or m.get("cacheWrite", 0) > 0:
            tokens_str += f" (cacheR={m['cacheRead']:,} cacheW={m['cacheWrite']:,})"
        cost_val = m.get("cost", {}).get("total", 0.0)
        cost_str = f"${cost_val:,.4f}"
        row_str = f"  {name:<{width}} | {tokens_str:<50} | {cost_str:>10}"
        if cache_report and "cacheReadShare" in m:
            share_val = m["cacheReadShare"]
            share_str = f"{share_val:.1%}" if share_val is not None else "n/a"
            cache_detail = (
                f"    cacheShare={share_str} warm={m.get('warmTurns', 0)} "
                f"cold={m.get('coldTurns', 0)} zero={m.get('zeroUsageTurns', 0)} "
                f"switches={m.get('modelSwitches', 0)} fallbacks={m.get('fallbackChanges', 0)}"
            )
            return f"{row_str}\n{cache_detail}"
        return row_str

    lines.append("=== PER AGENT ===")
    if data["per_agent"]:
        for agent, m in data["per_agent"].items():
            lines.append(format_row(agent, m))
    else:
        lines.append("  (none)")

    lines.append("")
    lines.append("=== PER DAY (UTC) ===")
    if data["per_day"]:
        for day, m in data["per_day"].items():
            lines.append(format_row(day, m, width=15))
    else:
        lines.append("  (none)")

    lines.append("")
    tot = data["total"]
    tot_tokens = f"in={tot['input']:,} out={tot['output']:,} total={tot['totalTokens']:,}"
    if tot.get("cacheRead", 0) > 0 or tot.get("cacheWrite", 0) > 0:
        tot_tokens += f" (cacheR={tot['cacheRead']:,} cacheW={tot['cacheWrite']:,})"
    tot_cost = f"${tot.get('cost', {}).get('total', 0.0):,.4f}"
    lines.append(f"TOTAL: {tot_tokens} | cost={tot_cost}")
    if cache_report and "cacheReadShare" in tot:
        share_val = tot["cacheReadShare"]
        share_str = f"{share_val:.1%}" if share_val is not None else "n/a"
        lines.append(
            f"  cacheShare={share_str} warm={tot.get('warmTurns', 0)} "
            f"cold={tot.get('coldTurns', 0)} zero={tot.get('zeroUsageTurns', 0)} "
            f"switches={tot.get('modelSwitches', 0)} fallbacks={tot.get('fallbackChanges', 0)}"
        )

    return "\n".join(lines)


def run_selftest() -> None:
    """Synthesizes all spec scenarios into temporary jsonl files and asserts correctness."""
    print("Running session_cost selftest...")

    # Scenario 1: assistant usage event is counted
    # GIVEN a jsonl line {"type":"message","message":{"role":"assistant","provider":"p","model":"m","timestamp":1,"usage":{"input":10,"output":5,"totalTokens":15,"cost":{"total":0.001}}}}
    # THEN totals include input=10, output=5, totalTokens=15, cost.total=0.001
    with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
        tf.write(
            '{"type":"message","message":{"role":"assistant","provider":"p","model":"m","timestamp":1,"usage":{"input":10,"output":5,"totalTokens":15,"cost":{"total":0.001}}}}\n'
        )
        tf_path1 = tf.name

    try:
        res1 = parse_and_aggregate([tf_path1])
        tot = res1["total"]
        assert tot["input"] == 10, f"Expected input 10, got {tot['input']}"
        assert tot["output"] == 5, f"Expected output 5, got {tot['output']}"
        assert tot["totalTokens"] == 15, f"Expected totalTokens 15, got {tot['totalTokens']}"
        assert abs(tot["cost"]["total"] - 0.001) < 1e-6, f"Expected cost 0.001, got {tot['cost']['total']}"
        print("  [PASS] Scenario: assistant usage event is counted")
    finally:
        os.remove(tf_path1)

    # Scenario 2: user event is ignored
    # GIVEN a jsonl line with message.role == "user" and no usage
    # THEN event contributes nothing and no error occurs
    with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
        tf.write('{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n')
        tf_path2 = tf.name

    try:
        res2 = parse_and_aggregate([tf_path2])
        assert res2["total"]["totalTokens"] == 0
        assert res2["total"]["input"] == 0
        assert len(res2["per_agent"]) == 0
        print("  [PASS] Scenario: user event is ignored")
    finally:
        os.remove(tf_path2)

    # Scenario 3: malformed line is skipped
    # GIVEN a line that is not valid JSON
    # THEN exits 0 and reports what it could parse
    with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
        tf.write('NOT VALID JSON\n')
        tf.write('{"type":"message","message":{"role":"assistant","provider":"p","model":"m","timestamp":1,"usage":{"input":4,"output":2,"totalTokens":6,"cost":{"total":0.002}}}}\n')
        tf.write('{"broken": json\n')
        tf_path3 = tf.name

    try:
        res3 = parse_and_aggregate([tf_path3])
        assert res3["total"]["totalTokens"] == 6
        assert res3["total"]["input"] == 4
        print("  [PASS] Scenario: malformed line is skipped")
    finally:
        os.remove(tf_path3)

    # Scenario 4: two models split per agent
    # GIVEN usage events with provider/model a/x and b/y
    # THEN per_agent has separate sums for a/x and b/y, and total equals their sum
    with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
        tf.write('{"type":"message","message":{"role":"assistant","provider":"a","model":"x","timestamp":1000,"usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.01}}}}\n')
        tf.write('{"type":"message","message":{"role":"assistant","provider":"b","model":"y","timestamp":1000,"usage":{"input":5,"output":5,"totalTokens":10,"cost":{"total":0.02}}}}\n')
        tf_path4 = tf.name
    try:
        res4 = parse_and_aggregate([tf_path4])
        assert "a/x" in res4["per_agent"]
        assert "b/y" in res4["per_agent"]
        assert res4["per_agent"]["a/x"]["totalTokens"] == 30
        assert res4["per_agent"]["b/y"]["totalTokens"] == 10
        assert res4["total"]["totalTokens"] == 40
        assert abs(res4["total"]["cost"]["total"] - 0.03) < 1e-6
        print("  [PASS] Scenario: two models split per agent")
    finally:
        os.remove(tf_path4)

    # Scenario 5: two days split per day
    # GIVEN usage events with timestamps on different UTC dates
    # THEN per_day groups each date separately
    # 2026-08-30 (1788091200) and 2026-09-01 (1788264000)
    with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
        # 2026-08-30T10:00:00Z -> 1788084000
        tf.write('{"type":"message","message":{"role":"assistant","provider":"a","model":"x","timestamp":"2026-08-30T10:00:00Z","usage":{"input":10,"output":10,"totalTokens":20,"cost":{"total":0.01}}}}\n')
        # 2026-09-01T10:00:00Z -> ISO string
        tf.write('{"type":"message","message":{"role":"assistant","provider":"a","model":"x","timestamp":"2026-09-01T10:00:00Z","usage":{"input":30,"output":30,"totalTokens":60,"cost":{"total":0.03}}}}\n')
        tf_path5 = tf.name

    try:
        res5 = parse_and_aggregate([tf_path5])
        assert "2026-08-30" in res5["per_day"]
        assert "2026-09-01" in res5["per_day"]
        assert res5["per_day"]["2026-08-30"]["totalTokens"] == 20
        assert res5["per_day"]["2026-09-01"]["totalTokens"] == 60
        assert res5["total"]["totalTokens"] == 80
        print("  [PASS] Scenario: two days split per day")
    finally:
        os.remove(tf_path5)

    # Scenario 6: json flag shape
    # Keys per_agent, per_day, total
    with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
        tf.write('{"type":"message","message":{"role":"assistant","provider":"a","model":"x","timestamp":1,"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}\n')
        tf_path6 = tf.name

    try:
        res6 = parse_and_aggregate([tf_path6])
        assert set(res6.keys()) == {"per_agent", "per_day", "total"}
        json_str = json.dumps(res6)
        parsed = json.loads(json_str)
        assert set(parsed.keys()) == {"per_agent", "per_day", "total"}
        print("  [PASS] Scenario: json flag shape")
    finally:
        os.remove(tf_path6)

    # Scenario 7: dependencies check
    # All imported modules in standard library
    import sys
    stdlib_names = sys.stdlib_module_names
    for mod in ("argparse", "collections", "datetime", "json", "os", "sys", "tempfile", "typing"):
        assert mod in stdlib_names, f"{mod} not in stdlib"
    print("  [PASS] Scenario: dependencies (stdlib only)")

    print("All selftest scenarios passed successfully (7/7)!")


def main() -> None:
    parser = argparse.ArgumentParser(description="Aggregate token usage and costs from .jsonl transcripts.")
    parser.add_argument("paths", nargs="*", help="One or more .jsonl transcript paths")
    parser.add_argument("--json", dest="as_json", action="store_true", help="Output JSON object only")
    parser.add_argument("--cache-report", dest="cache_report", action="store_true", help="Include neural prompt cache metrics")
    parser.add_argument("--selftest", action="store_true", help="Run self-tests and exit")

    args = parser.parse_args()

    if args.selftest:
        try:
            # Check standard library modules before running
            import sys
            stdlib_names = sys.stdlib_module_names
            for mod in ("argparse", "collections", "datetime", "json", "os", "sys", "tempfile", "typing"):
                assert mod in stdlib_names, f"{mod} not in stdlib"
            run_selftest()
            sys.exit(0)
        except Exception as e:
            print(f"Selftest failed: {e}", file=sys.stderr)
            sys.exit(1)

    if not args.paths:
        parser.print_help(sys.stderr)
        sys.exit(1)

    result = parse_and_aggregate(args.paths, cache_report=args.cache_report)

    if args.as_json:
        print(json.dumps(result, indent=2))
    else:
        print(format_table(result, cache_report=args.cache_report))

if __name__ == "__main__":
    main()
