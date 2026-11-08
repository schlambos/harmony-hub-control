# Security Notes

This project changes a Harmony Hub into a local-control appliance. Treat it as
trusted-LAN equipment.

## Current Policy

- Web UI sign-in (HTTP Basic Auth over the whole `:8080` surface) is optional
  and off by default; enable it under Settings → System → Sign-in.
- The web UI should only be reachable from a trusted local network.
- **Exports redact secrets while sign-in is off.** `GET /export/wifi`,
  `/export/mqtt`, and `/export/bundle` serve the Wi-Fi PSK and MQTT password
  as `__REDACTED__` whenever web UI sign-in is disabled, so another device on
  an IoT VLAN cannot scrape them. With sign-in enabled the caller has
  authenticated, and exports include the real passwords for full backups.
  Restoring a redacted export keeps the password already stored on the hub
  instead of overwriting it with the placeholder.
- **SSH password login stays enabled on purpose.** The payload's Dropbear
  runs without `-s -g`, so root accepts password logins alongside key auth.
  That is a deliberate lockout-recovery path: with key-only SSH, a dead
  laptop or lost SSH key would brick administrative access to the hub. If
  your hub sits on an IoT VLAN you don't fully trust, set a strong root
  password over SSH (`passwd`) after install.
- **The Wi-Fi recovery portal needs physical access.** `recovery_ap.sh` only
  starts `codex_portal` after the hub's reset button is held for 5 seconds
  (station mode is torn down first). The portal binds only to the recovery
  AP address (`192.168.76.1`), times idle clients out after 5 seconds, and
  validates SSID/password before writing `wpa_supplicant.conf` (control
  characters are stripped, so a submitted value cannot inject config lines).
- MQTT credentials are provided at install time or from the web UI and must not
  be committed.
- The hub installs software only through the installer, over SSH. Hub 1.2.0
  and older also accepted binaries over HTTP (`/api/update-begin`, `-chunk`,
  `-apply`) with a checksum list the client supplied. On a hub with sign-in
  off, any device on the network could replace a hub program that way. 1.3.0
  removed those routes, so update older hubs with the installer.

## Checking a download

Releases are not signed. Each release's `SHA256SUMS.txt` lists the SHA-256 of
every asset, so `shasum -a 256 -c SHA256SUMS.txt` proves a download is intact.
It doesn't prove who published it: anyone who can publish on the GitHub repo
can replace both the files and the checksums. The Android APK is the
exception, because Android only installs an update signed with the same key
as the installed app (certificate SHA-256 `7a766509…0bd2de`).

## Never Commit

- SSH private keys or `authorized_keys`
- MQTT passwords
- Home Assistant long-lived tokens
- Real hub backups
- Firmware dumps
- Rooting tools or vulnerability writeups
- Local IPs if they reveal a private deployment you do not want shared

## Before Sharing

Run a quick scan from the repo root:

```powershell
rg -n "PRIVATE KEY|BEGIN OPENSSH|password|authorized_keys|token|secret|credential" .
```

Review any hits before pushing or zipping the repository.

The installer intentionally writes `/etc/tdeenable` because the post-root
runtime expects the local service mode to remain enabled. That is runtime setup,
not a rooting method.
