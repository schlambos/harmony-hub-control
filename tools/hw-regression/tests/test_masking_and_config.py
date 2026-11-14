"""Unit tests for SecretMasker, RunConfig loading/safety policy, and BusyBox command guards."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from hwreg.config import RunConfig, load_local_config
from hwreg.masking import SecretMasker
from hwreg.models import SafetyTier
from hwreg.transport import audit_remote_command


class MaskingTests(unittest.TestCase):
    def test_masks_ips_macs_ssids_tokens_accounts_and_preserves_routing_constants(self) -> None:
        m = SecretMasker()
        m.register_ip("198.51.100.10", "<hub-wifi-ip>")
        m.register_ip("198.51.100.20", "<hub-wired-ip>")
        m.register_ip("198.51.100.1", "<gateway-ip>")
        m.register_mac("00:53:00:aa:bb:cc", "<mac-wifi>")
        m.register_mac("00:53:00:dd:ee:ff", "<mac-wired>")
        m.register_literal("MySecretHomeWiFi", "<ssid>")
        m.register_literal("/Users/alice/.ssh/my_hub_ed25519", "<ssh-key>")
        m.register_literal("88776655", "<hub-id>")

        sample = (
            "fw=4.15.600 kernel=2.6.31-g89d565c hub=88776655 key=/Users/alice/.ssh/my_hub_ed25519\n"
            "ssid=MySecretHomeWiFi\n"
            "password=supersecretpw Authorization: Bearer eyJhbGciOiJIUzI1NiJ9\n"
            "webhook=http://198.51.100.50:8123/api/webhook/wh-secret-999\n"
            '{"RFID":"abcd1234ef","AccountId":"91827364","email":"owner@example.org"}\n'
            "route: 198.51.100.0 0.0.0.0 255.255.255.0 U 0 0 0 eth2\n"
            "route: 224.0.0.0 0.0.0.0 240.0.0.0 U 0 0 0 ath0\n"
            "wol: sent Wake-on-LAN to 00:53:00:dd:ee:ff via 198.51.100.255 (eth2), 255.255.255.255\n"
            "unregistered peer 203.0.113.77 at 00:53:00:11:22:33"
        )
        masked = m.mask_text(sample)

        for forbidden in (
            "198.51.100.10",
            "198.51.100.20",
            "198.51.100.1",
            "198.51.100.50",
            "198.51.100.255",
            "203.0.113.77",
            "00:53:00:aa:bb:cc",
            "00:53:00:dd:ee:ff",
            "00:53:00:11:22:33",
            "MySecretHomeWiFi",
            "my_hub_ed25519",
            "88776655",
            "supersecretpw",
            "eyJhbGciOiJIUzI1NiJ9",
            "wh-secret-999",
            "abcd1234ef",
            "91827364",
            "owner@example.org",
        ):
            self.assertNotIn(forbidden, masked)

        # Public routing constants & firmware version stay readable for reviewers
        self.assertIn("4.15.600", masked)
        self.assertIn("0.0.0.0", masked)
        self.assertIn("255.255.255.0", masked)
        self.assertIn("255.255.255.255", masked)
        self.assertIn("224.0.0.0", masked)
        self.assertIn("<mac-wired>", masked)
        self.assertIn("<lan-bcast> (eth2)", masked)
        self.assertIn("/api/webhook/<webhook-id>", masked)


class ConfigAndSafetyPolicyTests(unittest.TestCase):
    def test_missing_config_raises_helpful_error(self) -> None:
        with self.assertRaises(FileNotFoundError) as ctx:
            load_local_config(Path("/nonexistent/config.local.json"))
        self.assertIn("config.example.json", str(ctx.exception))

    def test_rejects_persistent_safety_opt_in_flags_in_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "config.local.json"
            p.write_text(
                json.dumps({"ssh_target": "test-hub", "allow_reboot": True}),
                encoding="utf-8",
            )
            with self.assertRaises(ValueError) as ctx:
                load_local_config(p)
            self.assertIn("allow_reboot", str(ctx.exception))

    def test_tier_and_flag_gates_enforce_explicit_opt_in(self) -> None:
        cfg = RunConfig(ssh_target="test-hub")
        self.assertEqual(cfg.check_tier_permitted(SafetyTier.SAFE), (True, ""))

        ok, why = cfg.check_tier_permitted(SafetyTier.ACTIVE, "allow_activity_toggle")
        self.assertFalse(ok)
        self.assertIn("--tier active", why)

        cfg.tier = SafetyTier.ACTIVE
        ok, why = cfg.check_tier_permitted(SafetyTier.ACTIVE, "allow_activity_toggle")
        self.assertFalse(ok)
        self.assertIn("--allow-state-change", why)

        cfg.allow_state_change = True
        ok, why = cfg.check_tier_permitted(SafetyTier.ACTIVE, "allow_activity_toggle")
        self.assertFalse(ok)
        self.assertIn("--allow-activity-toggle", why)

        cfg.allow_activity_toggle = True
        self.assertEqual(cfg.check_tier_permitted(SafetyTier.ACTIVE, "allow_activity_toggle"), (True, ""))


class BusyBoxAndSafetyGuardTests(unittest.TestCase):
    def test_rejects_missing_busybox_applets_and_grep_extended(self) -> None:
        for bad_cmd in (
            "head -n 5 /etc/version",
            "dmesg | tail -20",
            "ps | sort",
            "find /data/codex -type f",
            "df -h",
            "stat /usr/bin/hal",
            "mktemp /tmp/foo.XXXXXX",
            "sha256sum /usr/bin/hal",
            "grep -E 'foo|bar' /cache/codex-init.log",
            "ping -c 1 -W 2 192.0.2.1",
            "ping -I eth2 192.0.2.1",
        ):
            with self.subTest(cmd=bad_cmd):
                with self.assertRaises(ValueError):
                    audit_remote_command(bad_cmd)

    def test_rejects_destructive_commands_and_mqtt_secret_reads(self) -> None:
        for forbidden_cmd in (
            "/data/codex/bin/codex_hal_ltcp 'sys.factoryreset' '\"1\"' 8",
            "rm -rf /data/resources",
            "rm -rf /data/codex-backups/old",
            "cat /data/codexmqtt/config.json",
        ):
            with self.subTest(cmd=forbidden_cmd):
                with self.assertRaises(PermissionError):
                    audit_remote_command(forbidden_cmd)

        # Pure non-empty existence probe on MQTT config IS permitted
        audit_remote_command("if [ -s /data/codexmqtt/config.json ]; then echo 1; fi")
