"""Synthetic hub transport fixtures for offline unit testing.

All test fixtures use RFC 5737 documentation IPv4 ranges (192.0.2.0/24,
198.51.100.0/24), RFC 7042 documentation MAC addresses (00:53:00:xx:xx:xx),
and synthetic labels so zero real hardware identifiers exist in the repo.
"""

from __future__ import annotations

import json
import urllib.parse
from typing import Any

from hwreg.checks_core import HAL_MULTI_REMOTE_MD5, HAL_STOCK_MD5, HAL_TWO_SCREEN_MD5
from hwreg.config import RunConfig
from hwreg.transport import HttpResult, HubTransport, SshResult, audit_remote_command


class FakeHubState:
    """Mutable in-memory model of a Harmony Hub for driving FakeHubTransport."""

    def __init__(self) -> None:
        self.ssh_reachable = True
        self.webui_reachable = True
        self.firmware = "4.15.600"
        self.kernel = "2.6.31-g89d565c"
        self.uptime_sec = 3600.0
        self.hub_id = "99001122"
        self.tde = "0"
        self.melodious_off = False
        self.resources_present = True
        self.mem_total_kb = 62524
        self.mem_free_kb = 14200
        self.buffers_kb = 2100
        self.cached_kb = 8400
        self.dmesg_lines: list[str] = [
            "Linux version 2.6.31-g89d565c",
            "ath0: link up",
        ]

        # Processes & binaries
        self.procs = [
            "1 root [init]",
            "410 root /usr/bin/hal -f -s",
            "455 root /usr/bin/lua /opt/luaworks/main.lua harmonyengine activityengine",
            "490 root /sbin/watchdog",
            "520 root /usr/sbin/wpa_supplicant -s -iath0 -c /etc/wpa_supplicant.conf",
            "610 root /data/codex/bin/dropbear -K 300",
            "640 root /bin/sh /data/codex/offline_egress_guard.sh monitor",
            "680 root /data/codex/bin/codex_webui 8080",
        ]
        self.webui_disk_md5 = "023b902e5a653a6bb4018b0c452cb08e"
        self.webui_exe_md5 = "023b902e5a653a6bb4018b0c452cb08e"
        self.guard_alive = True
        self.guard_restarts = 0

        # Conf gates & hal
        self.cloud_blocker = "1"
        self.two_screen = ""
        self.multi_remote = ""
        self.hal_bound = False
        self.hal_md5 = HAL_STOCK_MD5
        self.hal_gates = ""
        self.hal_tries = 0
        self.hal_remotes_present = False
        self.hal_remotes_md5 = HAL_TWO_SCREEN_MD5
        self.hal_remotes_load_rc = 0
        self.hal_multiremote_present = False
        self.hal_multiremote_md5 = HAL_MULTI_REMOTE_MD5

        # Networking & USB Ethernet
        self.wifi_ip = "192.0.2.10"
        self.wifi_bcast = "192.0.2.255"
        self.wifi_mac = "00:53:00:00:aa:01"
        self.wifi_up = True
        self.saved_gateway = "192.0.2.1"

        self.usb_eth_conf_enabled = False
        self.usb_eth_wifi_off = False
        self.usb_eth_state = "stopped"
        self.usb_eth_reason = ""
        self.usb_eth_ifname = ""
        self.usb_eth_ip = ""
        self.usb_eth_bcast = ""
        self.usb_eth_mac = "00:53:00:00:bb:02"
        self.usb_eth_driver = ""
        self.usb_eth_device = ""
        self.usb_eth_route_mode = ""
        self.arp_sysctls: dict[str, str] = {
            "ath0_arp_ignore": "0",
            "ath0_arp_announce": "0",
        }
        self.route_lines: list[str] = [
            "Kernel IP routing table",
            "Destination     Gateway         Genmask         Flags Metric Ref    Use Iface",
            "192.0.2.0       0.0.0.0         255.255.255.0   U     0      0        0 ath0",
            "10.0.0.0        192.0.2.1       255.0.0.0       UG    0      0        0 ath0",
            "172.16.0.0      192.0.2.1       255.240.0.0     UG    0      0        0 ath0",
            "192.168.0.0     192.0.2.1       255.255.0.0     UG    0      0        0 ath0",
            "224.0.0.0       0.0.0.0         240.0.0.0       U     0      0        0 ath0",
        ]
        self.flap_routes_on_second_read = False
        self._route_reads = 0

        # Interface counters
        self.iface_stats: dict[str, dict[str, int]] = {
            "ath0": {
                "rx_packets": 1000,
                "tx_packets": 950,
                "rx_bytes": 120000,
                "tx_bytes": 110000,
                "rx_errors": 0,
                "tx_errors": 0,
                "rx_dropped": 0,
                "tx_dropped": 0,
                "collisions": 0,
            },
            "eth2": {
                "rx_packets": 500,
                "tx_packets": 480,
                "rx_bytes": 80000,
                "tx_bytes": 75000,
                "rx_errors": 0,
                "tx_errors": 0,
                "rx_dropped": 0,
                "tx_dropped": 0,
                "collisions": 0,
            },
        }
        # When True, simulate the retracted bug: HTTP to wired_ip moves ath0 counters instead of eth2!
        self.simulate_wifi_leak_on_wired_http = False
        self.host_arp_table: dict[str, str] = {}
        self.gateway_ping_ok = True

        # RF Remotes & HOT stats
        self.rf_pairing_open = False
        self.rf_devices: list[dict[str, str]] = [
            {"DeviceIndex": "1", "EquadID": "16414", "SkinId": "", "RFID": "rf-serial-alpha-01"},
        ]
        self.hot_stats: dict[str, int] = {
            "RX OBJECTS": 120,
            "TX OBJECTS": 115,
            "MSG SEQ ERROR": 1,
            "TIMEOUT": 0,
            "IO ERROR": 0,
        }

        # Activities, Maps, Devices
        self.current_activity_id = "-1"
        self.restricted_activity_ids: set[str] = set()
        self.activities: list[dict[str, Any]] = [
            {"Id-": "1001", "Name": "Synth Activity One"},
            {"Id-": "1002", "Name": "Synth Activity Two"},
        ]
        self.button_maps: list[dict[str, Any]] = [
            {"__type": "RootButtonMap", "ButtonMapIdentifier": "16414Root", "Buttons": []},
            {
                "__type": "ActivityButtonMap",
                "ButtonMapIdentifier": "16414Activity1001",
                "Buttons": [{"ButtonKey": "VolumeUp", "ButtonAction": {"Id": 0}}],
            },
            {
                "__type": "ActivityButtonMap",
                "ButtonMapIdentifier": "16414Activity1002",
                "Buttons": [{"ButtonKey": "VolumeUp", "ButtonAction": {"Id": 0}}],
            },
        ]
        self.function_maps: list[dict[str, Any]] = [
            {"__type": "ActivityFunctionMap", "ActivityId-": "1001"},
            {"__type": "ActivityFunctionMap", "ActivityId-": "1002"},
        ]
        self.devices_with_features: list[dict[str, Any]] = [
            {"Device": {"Id-": "2001", "Label": "Synth Receiver"}},
        ]
        self.protocol_list_json = '{"Protocols":[]}'

        # Optional integrations
        self.bt_target = ""
        self.bt_profile = ""
        self.bt_devices_present = False
        self.restrictions_present = False
        self.mqtt_present = False
        self.tvs_tsv = ""
        self.androidtv_status_tvs: list[dict[str, Any]] = []
        self.wol_log_lines: list[str] = []
        self.wol_append_on_power_cmd: str = ""
        self.hold_calls: list[dict[str, str]] = []
        self.fail_hold_stage: str = ""

    def enable_two_screen(self, *, setting: str = "1", once_spent: bool = False) -> None:
        self.two_screen = "0" if once_spent else setting
        self.hal_bound = True
        self.hal_md5 = HAL_TWO_SCREEN_MD5
        self.hal_remotes_present = True
        serial_bit = "1" if setting.startswith("serial") else "0"
        multi_bit = "1" if self.multi_remote == "1" else "0"
        self.hal_gates = f"1{multi_bit}{serial_bit}"
        self.rf_devices = [
            {"DeviceIndex": "2", "EquadID": "16417", "SkinId": "99", "RFID": "rf-serial-touch-02"},
            {"DeviceIndex": "3", "EquadID": "16417", "SkinId": "105", "RFID": "rf-serial-950-03"},
        ]
        self.button_maps.extend(
            [
                # Screen remotes (16417) hold their own home/device UI locally and do NOT have a 16417Root map.
                {
                    "__type": "ActivityButtonMap",
                    "ButtonMapIdentifier": "16417Activity1001",
                    "Buttons": [{"ButtonKey": "VolumeUp", "ButtonAction": {"Id": 0}}],
                },
                {
                    "__type": "ActivityButtonMap",
                    "ButtonMapIdentifier": "16417Activity1002",
                    "Buttons": [{"ButtonKey": "VolumeUp", "ButtonAction": {"Id": 0}}],
                },
            ]
        )
        self.hot_stats = {
            "RX OBJECTS": 310,
            "TX OBJECTS": 305,
            "MSG SEQ ERROR": 4,
            "TIMEOUT": 0,
            "IO ERROR": 0,
            "TS MODE": 2 if serial_bit == "1" else 1,
            "TS SLOTS": (1 << 2) | (1 << 3),
            "TS CONTEXTS": 2,
            "TS DROPS": 0,
            "S2 LINK": 1,
            "S2 RX OBJECTS": 160,
            "S2 TX OBJECTS": 155,
            "S2 MSG SEQ ERROR": 2,
            "S2 TIMEOUT": 0,
            "S2 IO ERROR": 0,
            "S3 LINK": 1,
            "S3 RX OBJECTS": 150,
            "S3 TX OBJECTS": 150,
            "S3 MSG SEQ ERROR": 2,
            "S3 TIMEOUT": 0,
            "S3 IO ERROR": 0,
        }

    def enable_usb_eth_and_integrations(self) -> None:
        self.usb_eth_conf_enabled = True
        self.usb_eth_state = "operational"
        self.usb_eth_ifname = "eth2"
        self.usb_eth_ip = "192.0.2.20"
        self.usb_eth_bcast = "192.0.2.255"
        self.usb_eth_driver = "r8152"
        self.usb_eth_device = "0bda:8153"
        self.usb_eth_route_mode = "metric"
        self.host_arp_table[self.usb_eth_ip] = self.usb_eth_mac
        self.arp_sysctls = {
            "eth2_arp_ignore": "1",
            "eth2_arp_announce": "2",
            "ath0_arp_ignore": "1",
            "ath0_arp_announce": "2",
        }
        self.route_lines = [
            "Kernel IP routing table",
            "Destination     Gateway         Genmask         Flags Metric Ref    Use Iface",
            "192.0.2.0       0.0.0.0         255.255.255.0   U     0      0        0 eth2",
            "192.0.2.0       0.0.0.0         255.255.255.0   U     20     0        0 ath0",
            "10.0.0.0        192.0.2.1       255.0.0.0       UG    0      0        0 ath0",
            "172.16.0.0      192.0.2.1       255.240.0.0     UG    0      0        0 ath0",
            "192.168.0.0     192.0.2.1       255.255.0.0     UG    0      0        0 ath0",
            "224.0.0.0       0.0.0.0         240.0.0.0       U     0      0        0 ath0",
        ]
        self.procs.append("710 root /data/codex/bin/codex_androidtv")
        self.tvs_tsv = "androidtv01\t192.0.2.40\t00:53:00:00:cc:03\t00:53:00:00:cc:04\tSynth TV\n"
        self.androidtv_status_tvs = [
            {
                "id": "androidtv01",
                "name": "Synth TV",
                "host": "192.0.2.40",
                "mac": "00:53:00:00:cc:03",
                "connected": False,
                "on": False,
                "error": "",
            }
        ]
        self.wol_append_on_power_cmd = (
            "sent Wake-on-LAN to 00:53:00:00:cc:03 via 192.0.2.255 (eth2), 192.0.2.255 (ath0)"
        )
        self.devices_with_features.append(
            {
                "Device": {
                    "Id-": "2002",
                    "Label": "Synth HA Media",
                    "AutoDetectedDevice": {"Id": "melodious-ha-media_player.synth"},
                }
            }
        )
        self.protocol_list_json = (
            '{"Protocols":[{"Name":"Melodious Home Assistant",'
            '"ControlSection":{"Url":"http:\\/\\/192.0.2.50:8123\\/api\\/webhook\\/secret-hook-token-999"}}]}'
        )


class FakeHubTransport(HubTransport):
    """In-memory HubTransport executing BusyBox/safety audits on every SSH call."""

    def __init__(self, config: RunConfig, state: FakeHubState) -> None:
        super().__init__(config)
        self.state = state
        self.ssh_commands: list[str] = []
        self.sleeps: list[float] = []

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)

    def host_arp_mac(self, target_ip: str) -> str:
        return self.state.host_arp_table.get(target_ip, "")

    def _render_ifconfig(self, only_ath0: bool = False) -> str:
        st = self.state
        blocks: list[str] = []
        if st.wifi_up:
            blocks.append(
                f"ath0      Link encap:Ethernet  HWaddr {st.wifi_mac.upper()}\n"
                f"          inet addr:{st.wifi_ip}  Bcast:{st.wifi_bcast}  Mask:255.255.255.0\n"
                f"          UP BROADCAST RUNNING MULTICAST  MTU:1500  Metric:1"
            )
        else:
            blocks.append(
                f"ath0      Link encap:Ethernet  HWaddr {st.wifi_mac.upper()}\n"
                f"          BROADCAST MULTICAST  MTU:1500  Metric:1"
            )
        if not only_ath0 and st.usb_eth_ifname:
            flags = "UP BROADCAST RUNNING MULTICAST" if st.usb_eth_state == "operational" else "UP MULTICAST"
            ip_ln = (
                f"          inet addr:{st.usb_eth_ip}  Bcast:{st.usb_eth_bcast}  Mask:255.255.255.0\n"
                if st.usb_eth_ip
                else ""
            )
            blocks.append(
                f"{st.usb_eth_ifname:<9} Link encap:Ethernet  HWaddr {st.usb_eth_mac.upper()}\n"
                f"{ip_ln}"
                f"          {flags}  MTU:1500  Metric:1"
            )
        if not only_ath0:
            blocks.append(
                "lo        Link encap:Local Loopback\n"
                "          inet addr:127.0.0.1  Mask:255.0.0.0\n"
                "          UP LOOPBACK RUNNING  MTU:16436  Metric:1"
            )
        return "\n\n".join(blocks) + "\n"

    def _render_rf_info(self) -> str:
        payload = {
            "id": 1,
            "code": 200,
            "data": {
                "EquadID": "34827",
                "RFID": "rf-hub-master-00",
                "Devices": self.state.rf_devices,
                "DeviceCount": len(self.state.rf_devices),
            },
        }
        return json.dumps(payload)

    def _current_routes_text(self) -> str:
        self.state._route_reads += 1
        lines = list(self.state.route_lines)
        if self.state.flap_routes_on_second_read and self.state._route_reads % 2 == 0:
            lines.append("0.0.0.0         192.0.2.1       0.0.0.0         UG    0      0        0 ath0")
        return "\n".join(lines) + "\n"

    def run_ssh(
        self,
        command: str,
        timeout: int | None = None,
        *,
        host_override: str = "",
    ) -> SshResult:
        # Enforce BusyBox & safety command audit on every simulated SSH call!
        audit_remote_command(command)
        self.ssh_commands.append(command)
        st = self.state

        if not st.ssh_reachable:
            return SshResult(returncode=255, stdout="", stderr="ssh: connect to host failed")

        # 1. Discovery composite probe
        if "===META===" in command and "===ATH0===" in command:
            atv_proc = "1" if any("codex_androidtv" in p for p in st.procs) else "0"
            rf_pair = "1" if st.rf_pairing_open else "0"
            usb_lines = [
                f"conf_enabled={'1' if st.usb_eth_conf_enabled else '0'}",
                f"enabled={'1' if st.usb_eth_conf_enabled else '0'}",
                f"state={st.usb_eth_state}",
                f"service_state={st.usb_eth_state}",
                f"service_reason={st.usb_eth_reason}",
                f"ifname={st.usb_eth_ifname}",
                f"ipv4={st.usb_eth_ip}",
                f"usb_driver={st.usb_eth_driver}",
                f"usb_device={st.usb_eth_device}",
                f"route_mode={st.usb_eth_route_mode}",
            ]
            out = "\n".join(
                [
                    "===META===",
                    f"fw={st.firmware}",
                    f"kernel={st.kernel}",
                    f"uptime={st.uptime_sec} 1200.0",
                    f"hub_id={st.hub_id}",
                    f"tde={st.tde}",
                    f"melodious_off={'1' if st.melodious_off else '0'}",
                    f"resources_present={'1' if st.resources_present else '0'}",
                    f"cloud_blocker={st.cloud_blocker}",
                    f"two_screen={st.two_screen}",
                    f"multi_remote={st.multi_remote}",
                    f"hal_gates={st.hal_gates}",
                    f"hal_tries={st.hal_tries}",
                    f"hal_bound={'1' if st.hal_bound else '0'}",
                    f"hal_md5={st.hal_md5}",
                    f"saved_gw={st.saved_gateway}",
                    f"bt_target={st.bt_target}",
                    f"bt_profile={st.bt_profile}",
                    f"bt_devices_file={'1' if st.bt_devices_present else '0'}",
                    f"restrictions_file={'1' if st.restrictions_present else '0'}",
                    f"mqtt_file={'1' if st.mqtt_present else '0'}",
                    f"androidtv_proc={atv_proc}",
                    f"rf_pairing_proc={rf_pair}",
                    "===ATH0===",
                    self._render_ifconfig(only_ath0=True).strip(),
                    "===USBETH===",
                    *usb_lines,
                    "===TVS===",
                    st.tvs_tsv.strip(),
                    "===END===",
                ]
            )
            return SshResult(0, out + "\n", "")

        # 2. Wired MAC read
        if "/sys/class/net/" in command and "/address" in command:
            return SshResult(0, st.usb_eth_mac + "\n", "")

        # 3. ProtocolList.json read
        if "ProtocolList.json" in command:
            return SshResult(0, st.protocol_list_json + "\n", "")

        # 4. Boot & meminfo + dmesg check
        if "===MEM===" in command and "===DMESG===" in command:
            dmesg_hits = [
                ln
                for ln in st.dmesg_lines
                if any(k in ln.lower() for k in ("panic", "oops", "out of memory", "netdev watchdog", "tx timeout"))
            ]
            out = (
                "===MEM===\n"
                f"MemTotal:        {st.mem_total_kb} kB\n"
                f"MemFree:         {st.mem_free_kb} kB\n"
                f"Buffers:          {st.buffers_kb} kB\n"
                f"Cached:           {st.cached_kb} kB\n"
                "===DMESG===\n" + "\n".join(dmesg_hits) + "\n"
            )
            return SshResult(0, out, "")

        # 5. Services & process probe
        if "webui_disk_md5=" in command:
            ps_blob = "\n".join(st.procs)
            checks = {
                "hal": "hal" in ps_blob,
                "watchdog": "watchdog" in ps_blob,
                "dropbear": "dropbear" in ps_blob,
                "codex_webui": "codex_webui" in ps_blob,
                "offline_egress_guard": "offline_egress_guard" in ps_blob,
                "engine": any(
                    k in ps_blob
                    for k in ("/usr/bin/lua", "lua main.lua", "Lua", "luaworks", "harmonyengine", "activityengine")
                ),
            }
            lines = [f"proc_{k}={'1' if v else '0'}" for k, v in checks.items()]
            lines.append(f"webui_disk_md5={st.webui_disk_md5}")
            lines.append(f"webui_exe_mismatch={'1' if st.webui_disk_md5 != st.webui_exe_md5 else '0'}")
            lines.append(f"guard_restarts={st.guard_restarts}")
            lines.append("hal_log_warnings=0")
            return SshResult(0, "\n".join(lines) + "\n", "")

        # 6. hal_remotes load check & on-disk MD5 probe
        if "remotes_md5=" in command:
            if st.hal_remotes_present:
                lc = "ok" if st.hal_remotes_load_rc == 0 else f"rc_{st.hal_remotes_load_rc}"
                r_md5 = st.hal_remotes_md5
            else:
                lc = "absent"
                r_md5 = ""
            m_md5 = st.hal_multiremote_md5 if st.hal_multiremote_present else ""
            return SshResult(0, f"remotes_md5={r_md5}\nload_check={lc}\nmulti_md5={m_md5}\n", "")

        # 7. Cloud blocker route snapshot 1
        if "===R1===" in command:
            ga = "1" if st.guard_alive else "0"
            return SshResult(0, f"guard_alive={ga}\n===R1===\n" + self._current_routes_text(), "")

        # 8. USB-eth state + routes + dmesg
        if "===NETSTATE===" in command:
            w_off = "1" if st.usb_eth_wifi_off else "0"
            net_st = (
                f"wired_if={st.usb_eth_ifname}\nwifi_if=ath0\nwired_ip={st.usb_eth_ip}\n"
                f"route_mode={st.usb_eth_route_mode}\nnet_applied=1\n"
                if st.usb_eth_ifname
                else ""
            )
            usb_dmesg = [
                ln
                for ln in st.dmesg_lines
                if any(
                    k in ln.lower()
                    for k in ("r8152", "asix", "ax88179", "cdc_", "ehci", "tx timeout", "netdev watchdog", "-131", "-71")
                )
            ]
            out = (
                f"wifi_off_cfg={w_off}\n===NETSTATE===\n{net_st}"
                f"===ROUTES===\n{self._current_routes_text()}"
                f"===DMESG===\n" + "\n".join(usb_dmesg) + "\n"
            )
            return SshResult(0, out, "")

        # 9. ARP sysctls
        if "arp_ignore" in command and "arp_announce" in command:
            lines = [f"{k}={v}" for k, v in st.arp_sysctls.items()]
            return SshResult(0, "\n".join(lines) + "\n", "")

        # 10. Interface statistics counters
        if "/sys/class/net/" in command and "/statistics/" in command:
            ifname = "eth2" if "/eth2/" in command else "ath0"
            stats = st.iface_stats.get(ifname, {})
            lines = [f"{k}={stats.get(k, 0)}" for k in stats]
            return SshResult(0, "\n".join(lines) + "\n", "")

        # 11. WoL composite probe
        if "===IFCFG===" in command and "===WOL_LOG===" in command:
            out = (
                "===IFCFG===\n"
                + self._render_ifconfig(only_ath0=False)
                + "===ATVM==\natv_md5=f080f37972b83f31feab3acbed55b350\n===WOL_LOG===\n"
                + "\n".join(st.wol_log_lines)
                + "\n"
            )
            return SshResult(0, out, "")

        # 12. Live WoL PowerOn command on 127.0.0.1:8095/cmd
        if "127.0.0.1:8095/cmd" in command:
            if st.wol_append_on_power_cmd:
                st.wol_log_lines.append(st.wol_append_on_power_cmd)
            return SshResult(0, '{"ok":true}\n', "")

        # 13. WoL log grep
        if "codex-androidtv.log" in command:
            return SshResult(0, "\n".join(st.wol_log_lines) + ("\n" if st.wol_log_lines else ""), "")

        # 14. hot.stats or rf.info via codex_hal_ltcp
        if "codex_hal_ltcp" in command and "hot.stats" in command:
            return SshResult(0, json.dumps({"id": 1, "code": 200, "data": st.hot_stats}) + "\n", "")
        if "codex_hal_ltcp" in command and "rf.info" in command:
            return SshResult(0, self._render_rf_info() + "\n", "")

        # 15. Ping probes (BusyBox ping takes no flags; simulate gateway failure when requested)
        if command.startswith("ping "):
            if st.saved_gateway and st.saved_gateway in command and not st.gateway_ping_ok:
                return SshResult(1, f"No response from {st.saved_gateway}\n", "")
            return SshResult(0, f"{st.saved_gateway or '192.0.2.1'} is alive!\n", "")

        # 16. Plain `route -n`
        if command.strip().startswith("route -n"):
            return SshResult(0, self._current_routes_text(), "")

        return SshResult(0, "", "")

    def http_request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        content_type: str = "",
        host_override: str = "",
        timeout: int | None = None,
    ) -> HttpResult:
        st = self.state
        if not st.webui_reachable:
            return HttpResult(status=0, body="", error="connection refused")

        target_host = host_override or self.http_host

        if path == "/api/system-status":
            payload_str = json.dumps(
                {
                    "ok": True,
                    "firmware": st.firmware,
                    "uptime": "1h 0m",
                    "padding": "x" * 1800,
                }
            )
            payload_len = len(payload_str.encode("utf-8"))
            # Update simulated NIC counters when traffic targets wired_ip
            if st.usb_eth_ip and target_host == st.usb_eth_ip:
                if st.simulate_wifi_leak_on_wired_http:
                    st.iface_stats["ath0"]["rx_packets"] += 4
                    st.iface_stats["ath0"]["tx_packets"] += 5
                    st.iface_stats["ath0"]["tx_bytes"] += payload_len
                else:
                    st.iface_stats["eth2"]["rx_packets"] += 4
                    st.iface_stats["eth2"]["tx_packets"] += 5
                    st.iface_stats["eth2"]["rx_bytes"] += 320
                    st.iface_stats["eth2"]["tx_bytes"] += payload_len + 240
            return HttpResult(status=200, body=payload_str)

        if path == "/api/activity-state":
            hbus_reply = json.dumps(
                {
                    "cmd": "harmony.engine?getCurrentActivity",
                    "code": 200,
                    "msg": "OK",
                    "data": {"result": st.current_activity_id},
                }
            )
            return HttpResult(status=200, body=json.dumps({"ok": True, "reply": hbus_reply}))

        if path == "/api/activity-run" and method.upper() == "POST":
            form = urllib.parse.parse_qs((body or b"").decode("utf-8"))
            act_id = (form.get("activityId") or [""])[0]
            if act_id in st.restricted_activity_ids:
                return HttpResult(
                    status=409,
                    body=json.dumps({"ok": False, "restricted": True, "activityId": act_id}),
                    error="HTTP 409",
                )
            st.current_activity_id = act_id
            return HttpResult(status=200, body=json.dumps({"ok": True, "activityId": act_id, "reply": "{}"}))

        if path == "/api/activity-config":
            return HttpResult(
                status=200,
                body=json.dumps(
                    {
                        "revision": "rev-1",
                        "activityList": {"Activities": st.activities},
                        "mapList": {"ButtonMaps": st.button_maps},
                        "functionList": {"FunctionMaps": st.function_maps},
                        "deviceList": {"DevicesWithFeatures": st.devices_with_features},
                    }
                ),
            )

        if path == "/api/remotes":
            if st.rf_pairing_open:
                return HttpResult(status=200, body=json.dumps({"ok": True, "pairing": True}))
            return HttpResult(
                status=200,
                body=json.dumps(
                    {
                        "ok": True,
                        "pairing": False,
                        "multiRemote": st.hal_bound,
                        "slots": 6,
                        "reply": self._render_rf_info(),
                    }
                ),
            )

        if path == "/api/usb-eth":
            return HttpResult(
                status=200,
                body=json.dumps(
                    {
                        "ok": True,
                        "enabled": st.usb_eth_conf_enabled,
                        "supported": True,
                        "kernel": st.kernel,
                        "ehciBound": st.usb_eth_state == "operational",
                        "driverLoaded": st.usb_eth_state == "operational",
                        "ifname": st.usb_eth_ifname,
                        "carrier": st.usb_eth_state == "operational",
                        "ipv4": st.usb_eth_ip,
                        "operational": st.usb_eth_state == "operational",
                        "state": st.usb_eth_state,
                        "reason": st.usb_eth_reason,
                        "routeMode": st.usb_eth_route_mode,
                    }
                ),
            )

        if path == "/api/androidtv/status":
            return HttpResult(
                status=200,
                body=json.dumps({"ok": True, "identity": "ready", "tvs": st.androidtv_status_tvs}),
            )

        if path == "/api/ir-send" and method.upper() == "POST":
            form = {k: v[0] for k, v in urllib.parse.parse_qs((body or b"").decode("utf-8")).items()}
            st.hold_calls.append(form)
            if st.fail_hold_stage and form.get("status") == st.fail_hold_stage:
                return HttpResult(status=502, body=json.dumps({"ok": False}), error="HTTP 502")
            return HttpResult(status=200, body=json.dumps({"ok": True}))

        return HttpResult(status=404, body="not found", error="HTTP 404")
