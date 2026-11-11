# Activating a factory-fresh hub (no account, no Logitech cloud)

The complete runbook, as executed on hardware 2026-11-11: a second-hand
Harmony Hub (Pimento, skin 106) bound to a stranger's account was updated,
factory-reset over USB, rooted, provisioned on a fresh local account,
installed with Melodious, and paired with a remote running an activity —
no Logitech server contacted at any point, no previous owner's
credentials needed. The tooling lives in `tools/hub-root/`
(`run_harmony_hub_tool.py`); commands below assume it is running from
there with the hub connected over USB (which is also the hub's power
source in this setup — unplugging USB is a power-cycle).

Timings and hashes quoted are from that run; treat them as expectations,
not guarantees.


## Provenance

The root mechanism this chain builds on is the Harmony Hub root tool by
**Ripthulhu** and contributors (upstream: Ripthulhu/harmony-hub-root). That
tool — persistent key-only root SSH, USB diagnostics, Wi-Fi provisioning,
factory reset, firmware upload — is now **bundled into this repository** at
`tools/hub-root/`, under the upstream all-rights-reserved terms in
`LICENSE` section 1 (see `tools/hub-root/PROVENANCE.md`). Melodious's
additions there are the fresh-hub transports (POST, USB hbus) and the
TDE-gate handling that let the chain start from a blank hub.

## Coming next: automated fresh-hub installation

Everything in this runbook is currently a guided manual procedure. The
planned next step is a **one-command automated installer for fresh hubs**:
detect the hub over USB, check (and, with approval, update) the firmware,
reset, join Wi-Fi, open the TDE gate, provision the local account, seed
the starter config, root, install Melodious, and finish ready to pair a
remote — with the same checkpoints this runbook documents, and the
two wizard gaps below fixed so a blank hub needs no SSH workarounds.
Until that lands, this runbook is the procedure.

## Before you start: what is irreversible

- **Factory reset erases the hub's data and cache partitions**: account
  binding, all activities/devices/maps, Wi-Fi credentials, and any root
  or custom stack. On this hardware it also cleared the radio's RF
  pairings. If the hub has a setup you care about, capture it first
  (Step 0). Firmware and manufacturing identity survive.
- **The firmware update is one-way in practice.** No hub bundle exists
  to go back to 4.15.330.
- Everything after the reset is reversible by resetting again.

## Step 0 — Identify the hub and capture what the reset will destroy

Read-only over USB:

```sh
python3 run_harmony_hub_tool.py --action usb-preflight     # radio identity (/rf/deviceinfo)
python3 run_harmony_hub_tool.py --action usb-sysinfo
python3 run_harmony_hub_tool.py --action usb-hub-id        # provisioned hub ID, if any
python3 run_harmony_hub_tool.py --action usb-wifi-status
```

Photograph the underside label (model, serial). If the hub is on a LAN,
the current firmware and provisioning state are visible via
`connect.discoveryinfo?get` / `setup.account?getProvisionInfo` on 8088
(and, once you know the hub ID, the config resources `DeviceList`,
`ActivityList`, `MapList` over the WebSocket). Save any capture outside
this repo if it contains the previous owner's email/account ID; mask
those in anything shared.

**Firmware gate: the hub must end this step on 4.15.600.** The hal
patches and this chain are pinned to it. If it already is, skip Step 1.

## Step 1 — Update the firmware to 4.15.600 (official signed bundle)

There is no offline update path through Logitech's cloud in our posture,
but the official signed bundles are publicly indexed:
**github.com/Ripthulhu/harmony-hub-firmware** links each product/skin to
Logitech's own SUS (CloudFront) `.hfw2` file. The hub verifies the
bundle's RSA `sdigest` itself; these are unmodified Logitech images.

1. **Pick the file for your exact hub.** Identify the skin from the
   discovery record (`productId`/skin; our unit: Pimento, skin 106).
   Skins 97, 106 and 109 share the same hub bundle,
   `4.15.600.2987731.hfw2`. If your skin is not listed for that file,
   stop — do not flash another product's bundle.
2. **Download it and record the reference hash.** In our run:
   `4.15.600.2987731.hfw2`, 4,771,065 bytes, SHA-256
   `9eda076d10f32256221fbde3dd3e9ca839a720c2b96939a9c265c198a0f8029d`.
   Recompute and compare on your download; re-check the hash again
   immediately before flashing. The tool also reads the bundle's
   `Description.xml` (intended skins 97/106/109) and verifies each
   image's declared MD5; use `--dry-run` to see that without uploading.
3. **Flash it** (hub on the USB cable, cable secured, do not disconnect
   anything during the flash):

   ```sh
   python3 run_harmony_hub_tool.py --action usb-flash-firmware --firmware-file 4.15.600.2987731.hfw2
   ```

   Type `YES` at the prompt. Agree a stall timeout before starting
   (we used 15 minutes); do not interrupt a flash that is merely slow.
4. **Verify.** After the reboot, `connect.discoveryinfo?get` must report
   `current_fw_version` **4.15.600**. In our run the update preserved
   provisioning, Wi-Fi, the RF pairing and all config resources
   byte-identical. `/etc/version` and the hal md5 can only be confirmed
   after root (Step 6); the stock hal on 4.15.600 is md5
   `a3fdd823440c43f36e235fe51c45f008`.

## Step 2 — Factory reset over USB

```sh
python3 run_harmony_hub_tool.py --action usb-factory-reset
```

This sends the reset marker (`sys.factoryreset` body `"1"` — **not**
`"all"`, which additionally chip-erases the radio) and asks for `YES`.
The marker write is acknowledged by hal; the erase itself happens in the
initramfs on the next boot, which fast-blinks the red LED while it wipes
the data and cache partitions.

**What actually happened on our hub, so it does not surprise you:**

- The marker was accepted but the tool's `/sys/reboot` did **not** reboot
  the hub (it stayed up, still provisioned). A USB device-control reboot
  (operation `0xFF`, arg `0x00`, the same one used after firmware work)
  took it down.
- The hub then stayed absent from USB, still fast-blinking, past a
  10-minute watch. That is longer than the erase can plausibly take.
- **Recovery (worked first try): power-cycle = pull the USB cable**,
  wait 15 seconds, plug it back in. USB re-enumerated at **+9.6 s** and
  stayed stable. Do not pull power *while* a flash (Step 1) might be
  writing; for this reset step, after a long stall, the power-cycle is
  the recovery, and the wipe is idempotent.
- Fallback if a power-cycle ever leaves it blinking with no USB after
  ~5 minutes: hold the pair/reset button while plugging USB in (~5 s);
  U-Boot re-triggers the wipe. Not needed in our run.
- The steady fast red blink that remains afterwards is the hub's normal
  **"no config yet"** light on a fresh hub, not an error.

**Verify the fresh shape** (after Step 3 rejoins Wi-Fi):
`getProvisionInfo` returns only `discoveryServer`/`se` keys,
`setup.account?isprovisioned` → **551**, port 5222 closed, 8088
WebSocket → **401**, RF slot table empty. Anything else means the reset
did not take.

## Step 3 — Rejoin Wi-Fi

Check the exact SSID spelling first (a typo'd SSID cost us a round trip;
the hub reports a generic association error):

```sh
python3 run_harmony_hub_tool.py --action usb-wifi-scan --show-ssids
python3 run_harmony_hub_tool.py --action usb-provision-wifi --ssid "Your Wi-Fi"
```

Password at the hidden prompt. Note the hub's LAN address for later
steps (ours: 192.168.0.235).

## Step 4 — Why a fresh hub is a dead end, and the TDE gate that opens it

Three stock behaviours conspire: XMPP only starts when an
`AutomationConfig` resource exists (none does); the WebSocket needs the
provisioned hub ID (none exists); and `harmony.log?put` — the stock
chain's file write — returns 200 but saves nothing unless the hub is
already provisioned mode 3, so the TDE marker never lands and the file
APIs stay at 594.

The gate that does open pre-provisioning is hal's own `/tde/enable`:

- Read-back starts `"0"`. Write `"1"` **with the secondary-packet length
  byte set to the data length (`0x01`)**. Length `0x00` means "remove
  the marker" to hal's `libhal_tde_enable_write`, so a zero-length write
  is silently discarded (this cost us a session).
- Correct write → read-back `"1"`, `/etc/tdeenable` created,
  `connect.jsonfiletransfer` goes 594 → 200. Root file staging is now
  possible.

## Step 5 — Provision locally (no cloud)

Stock mode-3 provisioning calls Logitech. Instead, write the
provisioning preferences directly through the now-unlocked JSON file
API, at `/data/luaworks/provision/preferences`:

```json
{
  "accountId": "hub2-local-20261111",
  "authToken": "local",
  "configStale": true,
  "mode": 3,
  "name": "Hub 2",
  "susChannel": "",
  "remoteId": 20261111,
  "discoveryServerUri": "https://svcs.myharmony.com/Discovery/Discovery.svc",
  "discoveryServerUriCF": "https://svcs.myharmony.com/Discovery/Discovery.svc",
  "email": "hub2@local",
  "language": "en"
}
```

Details that bite:

- `remoteId` **must be a JSON number**. As a string, the WebSocket
  gate's `tonumber()` comparison never matches and every handshake is
  401, even with the right ID and domain. Pick an ID different from any
  other hub you own; it becomes the hub ID for the installer.
- Keep the default discovery URIs: the host part becomes `environment`,
  which must match what clients send.

Reboot (USB device-control reboot works). Verify `getProvisionInfo`
reports mode 3 with your account/remoteId and `isprovisioned` → 200
(over the WebSocket; on 8088 POST, mode 3 only allows
`getProvisionInfo`, so a 417 there is expected, not a failure).

## Step 6 — Seed AutomationConfig, then root

`harmony.automation?discover` refuses (587, "Automation config resource
missing") until an `AutomationConfig` resource and its index entry
exist. Create a minimal one (via `proxy.resource?put`, which writes the
resource and index together, or the JSON file API): an object with
`enableXMPP` set and empty devices/scenes/maps/programs/groups is
enough to satisfy the verifier.

Then root over USB:

```sh
python3 run_harmony_hub_tool.py --action lan-root --transport usb --hub-host <hub2-ip> --ignore-saved-hub-id
```

(`--transport post` also exists and is smoke-tested on a fresh hub; the
full root run was executed over USB.) Expect 554 payload chunks staged,
`discover` 200, Dropbear listening on 22. **Proof bar:**
`ssh root@<hub2-ip>` gives `uid=0(root)`; `/etc/version` reads
4.15.600; `md5sum /usr/bin/hal` is the stock pin above.

## Step 7 — Install Melodious and pair a remote

```sh
python3 install_webui.py --hub-host <hub2-ip> --hub-id <remoteId> --preflight-only
python3 install_webui.py --hub-host <hub2-ip> --hub-id <remoteId>
```

Do not pass `--skip-cloud-suppression`. Verify: cloud blocker on, web UI
on 8080, `codexactivity`/`codexmqtt` discover lines in
`/cache/codex-init.log`. Then in the web UI author a device and an
activity, open a pairing window (`/api/remote-pair`), and hold the
remote's pairing combo (Smart Control: Menu + Mute ~5 s). Proof: the
remote's press runs the activity (`activityStatus=2`), and the web UI
and state digest follow.

**Two wizard gaps on a truly empty hub (found in this run, fixes
tracked separately):**

1. `/api/activity-config` 503s until `DeviceList`, `ActivityList`,
   `FunctionList` and `MapList` exist. Workaround: create the four empty
   resources plus `ProtocolList` (SSH or file API) before opening the
   wizard.
2. The wizard creates `16414Activity<id>` but not `16414Root`, so the
   paired remote's activity button does nothing even though the hub
   receives its presses. Workaround: Settings → Remotes → Activity
   buttons, assign the activity (writes `16414Root`), then the button
   works.

## Troubleshooting (all observed on the run)

| Symptom | Cause / fix |
|---|---|
| Hub fast-blinking, absent from USB for many minutes after reset | Erase finished but boot hung, or slow erase. Power-cycle via the USB cable (15 s); expect enumeration in ~10 s. Button-held plug-in is the fallback. |
| `/tde/enable` write accepted, read-back still `"0"`, APIs still 594 | Length byte was `0x00` ("remove marker"). Re-send with length `0x01`. |
| `jsonfiletransfer?put` → 598 "Failed to decode json" | That API only accepts valid JSON content. Lua source cannot be staged through it; provision/seed with JSON (Steps 5–6) and let the mode-3 log writer stage code. |
| WebSocket 401 with the correct hub ID after provisioning | `remoteId` was written as a JSON string. Rewrite preferences with a numeric `remoteId`, reboot. |
| USB HID enumerated but LTCP stops answering after a reboot | Gadget wedge. USB device-control reboot (`0xFF`, arg `0x00`) re-initializes it; `usb-preflight` confirms. |
| Remote paired, hub sees presses, activity never starts | Missing `16414Root` map. See wizard gap 2 above. |
| Steady red blink on the fresh hub | Normal "no config yet" indication. Not a fault. |

## Known gaps (tracked, not yet fixed)

1. Wizard cannot load on an empty hub (Step 7, gap 1) — installer or API
   should seed empty resources on first run.
2. Wizard does not create the root button map (Step 7, gap 2) — wizard
   should write it with the first activity map.
3. Steps 5–6 (provisioning write with numeric-ID validation, and the
   AutomationConfig seed) should become tool commands in
   `tools/hub-root/` instead of manual operations.
4. POST-transport full root run is unproven (smoke-tested only).
