#!/usr/bin/env python3
"""Run a unittest file, leaving out the tests named.

  python3 tools/ci/unittest_except.py <file.py> [TestClass | TestClass.test_name ...]

unittest can select tests (-k) but not exclude them. tools/ci/run_suites.sh
uses this on Linux for the tests that need a macOS host. With nothing named
it runs the whole file, as `python3 <file.py>` does.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


def tests(suite: unittest.TestSuite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from tests(item)
        else:
            yield item


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(sys.argv[1]).resolve()
    left_out = set(sys.argv[2:])
    # as when the file is run directly: its own folder first on the path
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[path.stem] = module
    spec.loader.exec_module(module)
    found = list(tests(unittest.defaultTestLoader.loadTestsFromModule(module)))

    def names(test: unittest.TestCase) -> set[str]:
        cls = type(test).__name__
        return {cls, f"{cls}.{test._testMethodName}"}

    unknown = left_out - {name for test in found for name in names(test)}
    if unknown:
        print(f"error: no such test in {path.name}: {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2
    kept = [test for test in found if not names(test) & left_out]
    if left_out:
        print(f"left out: {len(found) - len(kept)} tests ({', '.join(sorted(left_out))})", file=sys.stderr)
    result = unittest.TextTestRunner(verbosity=1).run(unittest.TestSuite(kept))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
