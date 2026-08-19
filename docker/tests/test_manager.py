from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MANAGER_PATH = Path(__file__).resolve().parents[1] / "manager.py"
SPEC = importlib.util.spec_from_file_location("harmony_container_manager", MANAGER_PATH)
assert SPEC is not None and SPEC.loader is not None
manager = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = manager
SPEC.loader.exec_module(manager)


class ManagerTests(unittest.TestCase):
    def base_env(self, root: Path) -> dict[str, str]:
        return {
            "HUB_HOST": "192.168.1.44",
            "HUB_ID": "12345678",
            "SSH_KEY_PATH": str(root / "key"),
            "HARMONY_APP_ROOT": str(root / "app"),
            "HARMONY_CONFIG_ROOT": str(root / "config"),
            "HARMONY_RUNTIME_ROOT": str(root / "run"),
        }

    def test_boolean_parser_is_strict(self) -> None:
        self.assertTrue(manager.env_bool({"X": "YES"}, "X", False))
        self.assertFalse(manager.env_bool({"X": "off"}, "X", True))
        with self.assertRaises(manager.ConfigError):
            manager.env_bool({"X": "sometimes"}, "X", False)

    def test_host_validation_accepts_lan_names_and_ipv6(self) -> None:
        self.assertEqual(manager.normalize_host("Harmony-Hub.local"), "harmony-hub.local")
        self.assertEqual(manager.normalize_host("[fd00::44]"), "fd00::44")
        with self.assertRaises(manager.ConfigError):
            manager.normalize_host("http://192.168.1.44:8080/")

    def test_disabled_mqtt_does_not_require_broker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            settings = manager.Settings.from_env(self.base_env(Path(temporary)))
            self.assertFalse(settings.mqtt_enabled)
            args = manager.installer_arguments(settings, Path("/run/key"))
            self.assertIn("--mqtt-disabled", args)
            self.assertNotIn("--mqtt-password", args)

    def test_enabled_mqtt_and_safe_cloud_flags(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            env = self.base_env(Path(temporary))
            env.update(
                {
                    "MQTT_ENABLED": "true",
                    "MQTT_BROKER": "192.168.1.10",
                    "MQTT_PASSWORD": "not-logged",
                    "CLOUD_BLOCKER_ENABLED": "true",
                    "REBOOT_HUB_AFTER_INSTALL": "false",
                }
            )
            settings = manager.Settings.from_env(env)
            args = manager.installer_arguments(settings, Path("/run/key"))
            self.assertIn("--mqtt-broker", args)
            self.assertIn("--mqtt-password", args)
            self.assertIn("--no-apply-cloud-restart", args)
            self.assertNotIn("--skip-cloud-suppression", args)

    def test_marker_prevents_repeat_install_for_same_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "app"
            app.mkdir()
            (app / "UPSTREAM_REVISION").write_text("abc123\n", encoding="utf-8")
            settings = manager.Settings.from_env(self.base_env(root))
            manager.ensure_runtime_dirs(settings)
            needed, _ = manager.install_needed(settings)
            self.assertTrue(needed)
            manager.write_marker(settings)
            needed, reason = manager.install_needed(settings)
            self.assertFalse(needed)
            self.assertIn("matching", reason)
            marker = json.loads(settings.marker_path.read_text(encoding="utf-8"))
            self.assertNotIn("mqtt_password", marker)

    def test_target_change_requires_install(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "app"
            app.mkdir()
            (app / "UPSTREAM_REVISION").write_text("abc123\n", encoding="utf-8")
            first = manager.Settings.from_env(self.base_env(root))
            manager.ensure_runtime_dirs(first)
            manager.write_marker(first)
            changed_env = self.base_env(root)
            changed_env["HUB_HOST"] = "192.168.1.45"
            changed = manager.Settings.from_env(changed_env)
            needed, reason = manager.install_needed(changed)
            self.assertTrue(needed)
            self.assertEqual(reason, "HUB_HOST changed")

    def test_nginx_proxy_targets_hub_and_preserves_auth_header(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            settings = manager.Settings.from_env(self.base_env(Path(temporary)))
            config = manager.nginx_config(settings)
            self.assertIn("proxy_pass http://192.168.1.44:8080;", config)
            self.assertIn("proxy_set_header Host $proxy_host;", config)
            self.assertIn("proxy_set_header Authorization $http_authorization;", config)
            self.assertIn("location = /container-health", config)

    def test_perform_install_writes_marker_and_removes_runtime_key(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "app"
            app.mkdir()
            (app / "UPSTREAM_REVISION").write_text("abc123\n", encoding="utf-8")
            (app / "install_webui.py").write_text(
                "def main(args):\n"
                "    assert '--no-prompt' in args\n"
                "    assert '--mqtt-disabled' in args\n"
                "    return 0\n",
                encoding="utf-8",
            )
            (root / "key").write_text("test-private-key\n", encoding="utf-8")
            settings = manager.Settings.from_env(self.base_env(root))
            manager.perform_install(settings)
            self.assertTrue(settings.marker_path.is_file())
            self.assertFalse((settings.runtime_root / "deploy_key").exists())

    def test_failed_install_does_not_write_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "app"
            app.mkdir()
            (app / "UPSTREAM_REVISION").write_text("abc123\n", encoding="utf-8")
            (app / "install_webui.py").write_text(
                "def main(args):\n"
                "    raise SystemExit(7)\n",
                encoding="utf-8",
            )
            (root / "key").write_text("test-private-key\n", encoding="utf-8")
            settings = manager.Settings.from_env(self.base_env(root))
            with self.assertRaises(RuntimeError):
                manager.perform_install(settings)
            self.assertFalse(settings.marker_path.exists())
            self.assertFalse((settings.runtime_root / "deploy_key").exists())


if __name__ == "__main__":
    unittest.main()
