from __future__ import annotations

from pathlib import Path
import argparse


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "base", nargs="?", default=str(Path.cwd() / "biblicism_workspace")
    )
    args = parser.parse_args()

    base = Path(args.base)
    for name in ("source", "temp", "example", "output", "context"):
        (base / name).mkdir(parents=True, exist_ok=True)

    print(str(base))


if __name__ == "__main__":
    main()
