# Activating a factory-fresh hub (no account, no Logitech cloud)

How a factory-reset or second-hand Harmony Hub goes from blank to rooted,
provisioned on a local account, running Melodious, with a paired remote —
without contacting any Logitech server. Proven end to end on hardware
2026-11-11 (second-hand Pimento hub, skin 106, firmware 4.15.600).
The tooling lives in `tools/hub-root/`; this document is the chain.

## Why a fresh hub used to be a dead end

- XMPP (5222) only starts when an `AutomationConfig` resource with
  `enableXMPP` loads. A fresh hub has no resources.
- The 8088 WebSocket validates `hubId == remoteId`; both are nil before
  provisioning, so every handshake is 401.
- `harmony.log?put` returns 200 unprovisioned but writes nothing:
  `processPutLog` only calls `saveLog` when the hub is provisioned
  mode 3. The TDE marker never lands and the file APIs stay gated (594).
- Stock mode-3 provisioning calls Logitech's cloud, which is dead to us.

## The chain

1. **Firmware gate.** The hub must be on 4.15.600 (hal patches and the
   root chain are pinned/tested to it). Official signed bundles are
   indexed at github.com/Ripthulhu/harmony-hub-firmware; flashing is
   one-way in practice (no hub bundle exists to go back).
2. **Join Wi-Fi over USB**: `usb-provision-wifi`. Confirm the fresh shape
   (`isprovisioned` 551, 5222 closed, WebSocket 401).
3. **Open the TDE gate**: write hal's `/tde/enable` over USB with the
   correct secondary-packet length byte. Length `0x00` means "remove the
   marker" to `libhal_tde_enable_write`; length `0x01` creates
   `/etc/tdeenable` and unlocks `connect.jsonfiletransfer`.
4. **Provision locally**: write `/data/luaworks/provision/preferences`
   through the unlocked JSON file API — mode 3, fresh local `accountId`,
   `remoteId` as a **JSON number** (a string makes every WebSocket
   handshake 401), default discovery URIs. Reboot; `isprovisioned` → 200.
5. **Seed a minimal `AutomationConfig`** resource + index entry, or
   `harmony.automation?discover` refuses (587) and the loader never runs.
6. **Root** over USB: `run_harmony_hub_tool.py --action lan-root
   --transport usb --ignore-saved-hub-id`. Dropbear lands on port 22.
   Proof bar: `uid=0(root)`, `/etc/version`, stock hal md5.
7. **Install Melodious** from this repo (`install_webui.py`, no
   `--skip-cloud-suppression`). Then author config and pair a remote
   normally.

Notes from the hardware run: a `"1"` factory reset clears the radio's RF
pairings too (re-pairing is part of the chain); USB HID can stop
answering LTCP after a reboot, and a USB device-control reboot
(`0xFF`, arg `0x00`) recovers it.

## Known gaps (tracked, not yet fixed)

1. **Wizard cannot load on an empty hub.** `/api/activity-config` 503s
   when `DeviceList`/`ActivityList`/`FunctionList`/`MapList` do not
   exist. Workaround: bootstrap the four empty resources + `ProtocolList`
   over SSH. Fix: installer or API seeds empty resources on first run.
2. **Wizard does not create the root button map.** First activity yields
   `16414Activity<id>` but no `16414Root`; the paired remote's activity
   button is dead until the root map is created (Settings → Remotes →
   Activity buttons). Fix: wizard writes the root map with the first
   activity map.
3. **Steps 4–5 are manual.** The provisioning write (with numeric
   `remoteId` validation) and the AutomationConfig seed should become
   tool steps in `tools/hub-root/`.
4. **POST transport root run unproven.** `--transport post` is
   smoke-tested on a fresh hub; the full root chain was executed over
   USB.
