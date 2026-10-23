#!/usr/bin/env python3
"""Read a file off the paired Harmony Touch, read-only, over HOT.

Uses the codexactivity plugin's ReadTouchFile op (branch feat/touch-file-read):
the plugin issues hot.1.data.resource from inside the engine, where hbus
forwarding is unrestricted, and lands the body on the hub at
/var/volatile/codex-touch-read.bin. This driver sends the request over SSH,
waits for the JSON response, and downloads the body.

Only allowlisted paths can be read (enforced in the plugin). Nothing here
writes to the Touch; the only hub writes are the request/response files in
/var/volatile (RAM).

Usage:
  python3 tools/touch_read.py /data/resources/index.json -o touch-index.json
  python3 tools/touch_read.py /data/resources/MapList.json   # stdout metadata only with --meta
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import time
import uuid

REQUEST_FILE = "/var/volatile/codex-activity-request.json"
RESPONSE_FILE = "/var/volatile/codex-activity-response.json"
BODY_FILE = "/var/volatile/codex-touch-read.bin"


def ssh(host: str, command: str, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["ssh", "-o", "ConnectTimeout=10", host, command],
        capture_output=True, timeout=timeout,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="absolute path on the Touch (allowlisted)")
    parser.add_argument("-o", "--output", help="local file to save the body to")
    parser.add_argument("--host", default="harmony-hub", help="ssh host alias")
    parser.add_argument("--meta", action="store_true",
                        help="print the JSON response metadata")
    args = parser.parse_args()

    request_id = uuid.uuid4().hex[:16]
    request = json.dumps(
        {"id": request_id, "op": "ReadTouchFile", "path": args.path})
    write_cmd = (
        f"printf %s {shlex.quote(request)} > {REQUEST_FILE}.new && "
        f"mv {REQUEST_FILE}.new {REQUEST_FILE} && rm -f {RESPONSE_FILE}"
    )
    if ssh(args.host, write_cmd).returncode != 0:
        print("failed to send the request to the hub", file=sys.stderr)
        return 1

    deadline = time.time() + 100
    response = None
    while time.time() < deadline:
        proc = ssh(args.host, f"cat {RESPONSE_FILE} 2>/dev/null")
        if proc.returncode == 0 and proc.stdout.strip():
            try:
                response = json.loads(proc.stdout)
            except json.JSONDecodeError:
                response = None
            if response and str(response.get("id")) == request_id:
                break
            response = None
        time.sleep(1)

    if response is None:
        print("timed out waiting for the plugin response "
              "(is the Touch awake and the plugin deployed?)", file=sys.stderr)
        return 1
    if args.meta or not response.get("ok"):
        print(json.dumps(response, indent=2))
    if not response.get("ok"):
        return 1

    proc = ssh(args.host, f"cat {BODY_FILE}", timeout=180)
    if proc.returncode != 0:
        print("failed to download the body from the hub", file=sys.stderr)
        return 1
    body = proc.stdout
    expected = response.get("bytes")
    if expected is not None and len(body) != expected:
        print(f"warning: got {len(body)} bytes, metadata says {expected}",
              file=sys.stderr)
    if args.output:
        with open(args.output, "wb") as f:
            f.write(body)
        print(f"saved {len(body)} bytes to {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
