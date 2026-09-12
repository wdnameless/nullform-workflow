from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(
            "Usage: save_and_build.py <workspace> <json-file>\n"
            "  json-file: path to a JSON file with biblicism data\n"
            "  workspace: path to biblicism_workspace folder"
        )

    workspace = Path(sys.argv[1])
    json_source = Path(sys.argv[2])

    if not json_source.exists():
        raise SystemExit(f"ERROR: JSON file not found: {json_source}")

    data = json.loads(json_source.read_text(encoding="utf-8"))
    if not isinstance(data, list) or len(data) == 0:
        raise SystemExit("ERROR: JSON must be a non-empty list of objects")

    temp = workspace / "temp"
    temp.mkdir(parents=True, exist_ok=True)
    data_json = temp / "data.json"
    data_json.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    script_dir = Path(__file__).resolve().parent
    pipeline = script_dir / "run_pipeline.py"

    result = subprocess.run(
        [
            sys.executable,
            "-X",
            "utf8",
            str(pipeline),
            "finalize",
            "--workspace",
            str(workspace),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )

    if result.stdout.strip():
        print(result.stdout.strip())
    if result.returncode != 0:
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
