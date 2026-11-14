"""Context-aware secret, address, and identifier masking for PR-safe reports.

Follows Melodious repository masking conventions:
- Never emit real LAN IPv4/IPv6 addresses, MAC addresses, Wi-Fi SSIDs, SSH key
  paths, hub IDs, RF serials (RFID), account IDs/emails, webhook tokens, or
  passwords in committed or PR-attached output.
- Preserve diagnostic distinguishability using stable role/indexed placeholders
  (e.g. `<hub-wifi-ip>` vs `<hub-wired-ip>`, `<mac-wifi>` vs `<mac-wired>`,
  `<rfid-1>` vs `<rfid-2>`) while leaving non-secret networking constants
  (`0.0.0.0`, `127.0.0.1`, `255.255.255.255`, `224.0.0.0`, netmasks) intact so
  routing tables and WoL logs remain inspectable by reviewers.
"""

from __future__ import annotations

import re
from typing import Any


MAC_RE = re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b")
IPV4_RE = re.compile(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b")
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
WEBHOOK_RE = re.compile(
    r"(https?:(?:/|\\/){2}[^\s\"'>]+(?:/|\\/)api(?:/|\\/)webhook(?:/|\\/))([^\s\"'/?#&>\\]+)",
    re.IGNORECASE,
)
KV_SECRET_RE = re.compile(
    r"(?i)\b(password|passwd|psk|secret|token|authorization|cookie|api[_-]?key)\s*([:=])\s*([^\s,;\"']+)"
)
BEARER_RE = re.compile(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*")
JSON_RFID_RE = re.compile(r'("RFID"\s*:\s*")([^"]+)(")')
JSON_ACCOUNT_RE = re.compile(r'("(?:AccountId-?|accountId|email|userAuthToken)"\s*:\s*")([^"]+)(")')
SSID_LINE_RE = re.compile(r'(?m)^(\s*(?:ssid|ESSID)\s*[:=]\s*"?)([^"\r\n]+)("?)')

# Non-identifying IPv4 constants & netmasks that reviewers need verbatim in
# routing and multicast/broadcast output.
PUBLIC_ROUTING_CONSTANTS = frozenset(
    {
        "0.0.0.0",
        "127.0.0.1",
        "224.0.0.0",
        "240.0.0.0",
        "255.0.0.0",
        "255.240.0.0",
        "255.255.0.0",
        "255.255.128.0",
        "255.255.192.0",
        "255.255.224.0",
        "255.255.240.0",
        "255.255.248.0",
        "255.255.252.0",
        "255.255.254.0",
        "255.255.255.0",
        "255.255.255.128",
        "255.255.255.192",
        "255.255.255.224",
        "255.255.255.240",
        "255.255.255.248",
        "255.255.255.252",
        "255.255.255.254",
        "255.255.255.255",
        # RFC 1918 aggregate prefixes installed by offline_egress_guard.sh
        "10.0.0.0",
        "172.16.0.0",
        "192.168.0.0",
    }
)

SENSITIVE_DICT_KEYS = frozenset(
    {
        "password",
        "passwd",
        "psk",
        "webui_password",
        "token",
        "access_token",
        "refresh_token",
        "authorization",
        "cookie",
        "secret",
        "ssh_key_path",
        "accountid",
        "accountid-",
        "email",
    }
)


class SecretMasker:
    """Stateful per-run masker keeping stable placeholders across a report."""

    def __init__(self) -> None:
        self._ip_roles: dict[str, str] = {}
        self._mac_roles: dict[str, str] = {}
        self._rfid_roles: dict[str, str] = {}
        self._literals: dict[str, str] = {}

    def register_ip(self, ip: str, placeholder: str) -> None:
        val = ip.strip()
        if val and val not in PUBLIC_ROUTING_CONSTANTS:
            self._ip_roles[val] = placeholder
            # Also register the likely /24 subnet and broadcast if standard LAN
            parts = val.split(".")
            if len(parts) == 4 and all(p.isdigit() for p in parts):
                subnet = f"{parts[0]}.{parts[1]}.{parts[2]}.0"
                bcast = f"{parts[0]}.{parts[1]}.{parts[2]}.255"
                if subnet not in PUBLIC_ROUTING_CONSTANTS:
                    self._ip_roles.setdefault(subnet, "<lan-subnet>")
                self._ip_roles.setdefault(bcast, "<lan-bcast>")

    def register_mac(self, mac: str, placeholder: str) -> None:
        norm = self._norm_mac(mac)
        if norm:
            self._mac_roles[norm] = placeholder

    def register_rfid(self, rfid: str, placeholder: str = "") -> None:
        val = rfid.strip()
        if not val:
            return
        if val not in self._rfid_roles:
            tag = placeholder or f"<rfid-{len(self._rfid_roles) + 1}>"
            self._rfid_roles[val] = tag

    def register_literal(self, secret: str, placeholder: str = "<redacted>") -> None:
        val = secret.strip()
        if len(val) >= 3:
            self._literals[val] = placeholder

    @staticmethod
    def _norm_mac(mac: str) -> str:
        val = mac.strip().lower().replace("-", ":")
        if MAC_RE.fullmatch(val):
            return val
        return ""

    def _mask_mac_match(self, match: re.Match[str]) -> str:
        raw = match.group(0)
        norm = raw.lower().replace("-", ":")
        if norm in {"00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"}:
            return raw
        if norm not in self._mac_roles:
            self._mac_roles[norm] = f"<mac-{len(self._mac_roles) + 1}>"
        return self._mac_roles[norm]

    def _mask_ipv4_match(self, match: re.Match[str]) -> str:
        octets = [int(match.group(i)) for i in range(1, 5)]
        if any(o > 255 for o in octets):
            return match.group(0)
        ip = match.group(0)
        if ip in PUBLIC_ROUTING_CONSTANTS:
            return ip
        if ip not in self._ip_roles:
            if octets[3] == 255:
                self._ip_roles[ip] = "<lan-bcast>"
            elif octets[3] == 0:
                self._ip_roles[ip] = "<lan-subnet>"
            else:
                self._ip_roles[ip] = f"<ip-{len(self._ip_roles) + 1}>"
        return self._ip_roles[ip]

    def _mask_rfid_json(self, match: re.Match[str]) -> str:
        prefix, val, suffix = match.group(1), match.group(2), match.group(3)
        if val.startswith("<") and val.endswith(">"):
            return match.group(0)
        self.register_rfid(val)
        return f"{prefix}{self._rfid_roles.get(val, '<rfid>')}{suffix}"

    def mask_text(self, text: str) -> str:
        if not text:
            return text
        out = text
        # 1. Structured tokens & credentials before generic replacements
        out = WEBHOOK_RE.sub(r"\1<webhook-id>", out)
        out = BEARER_RE.sub(r"\1 <redacted>", out)
        out = KV_SECRET_RE.sub(r"\1\2<redacted>", out)
        out = JSON_RFID_RE.sub(self._mask_rfid_json, out)
        out = JSON_ACCOUNT_RE.sub(r"\1<account-redacted>\3", out)
        out = SSID_LINE_RE.sub(r"\1<ssid>\3", out)
        out = EMAIL_RE.sub("<email-redacted>", out)

        # 2. Registered literal secrets (longest first to avoid partial splits)
        for literal in sorted(self._literals, key=len, reverse=True):
            out = out.replace(literal, self._literals[literal])
        for rfid, tag in sorted(self._rfid_roles.items(), key=lambda kv: len(kv[0]), reverse=True):
            if len(rfid) >= 6:
                out = out.replace(rfid, tag)

        # 3. MAC addresses & IPv4 addresses
        out = MAC_RE.sub(self._mask_mac_match, out)
        out = IPV4_RE.sub(self._mask_ipv4_match, out)
        return out

    def mask_value(self, value: Any, key: str = "") -> Any:
        """Recursively sanitize dicts, lists, and strings."""
        if key.lower() in SENSITIVE_DICT_KEYS:
            return "<redacted>" if value else ""
        if isinstance(value, dict):
            return {self.mask_text(str(k)): self.mask_value(v, str(k)) for k, v in value.items()}
        if isinstance(value, list):
            return [self.mask_value(item) for item in value]
        if isinstance(value, tuple):
            return [self.mask_value(item) for item in value]
        if isinstance(value, str):
            return self.mask_text(value)
        return value
