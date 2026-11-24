#!/usr/bin/env python3
"""Compile every Python file a user runs, with the running interpreter.

The documented minimum is Python 3.10 (tools/hub-root/README.md,
tools/hw-regression/README.md), but the suites normally run on a newer
Python, where 3.12-only syntax (a backslash inside an f-string expression,
PEP 701) parses fine and only fails on a user's 3.10/3.11 machine. CI runs
this under a real 3.10 (the python-floor job in .github/workflows/ci.yml);
run_suites.sh runs it too, so the file list itself stays exercised.

Scope: the Python a user runs - the installer, the hub-root tool the
desktop Setup Wizard bundles and runs (with its own 3.12 on macOS/Windows,
but the same files also run under the user's Python from the command
line), the catalog helper, the Docker manager and the hardware
regression runner. Tests inside those trees are compiled too: they are
run with the same interpreter.

Exit 0 when every file compiles, 1 listing each failure otherwise.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

FILES = [
    "install_webui.py",
    "docker/manager.py",
]
TREES = [
    "tools/hub-root",
    "tools/catalog",
    "tools/hw-regression",
    "docker/tests",
]
FLOOR = (3, 10)


def targets() -> list[Path]:
    found = [ROOT / name for name in FILES]
    for tree in TREES:
        found.extend(sorted((ROOT / tree).rglob("*.py")))
    return [p for p in found if "__pycache__" not in p.parts]


def main() -> int:
    version = sys.version_info[:2]
    print(f"python-floor: interpreter {version[0]}.{version[1]}, floor {FLOOR[0]}.{FLOOR[1]}")
    if version > FLOOR:
        print(
            "python-floor: note: this interpreter is newer than the floor, so this "
            "run checks the file list only; CI's python-floor job runs the real "
            f"{FLOOR[0]}.{FLOOR[1]} compile."
        )
    failures = []
    for path in targets():
        try:
            compile(path.read_bytes(), str(path), "exec")
        except SyntaxError as error:
            failures.append(f"{path.relative_to(ROOT)}:{error.lineno}: {error.msg}")
    if failures:
        print("python-floor: FAILED to compile under this interpreter:")
        for failure in failures:
            print(f"  {failure}")
        return 1
    print(f"python-floor: {len(targets())} files compile")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
