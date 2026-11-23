# Nintendo Switch 2 Wake

Melodious can wake a sleeping **Nintendo Switch 2** directly from the Harmony Hub over Bluetooth Low Energy (BLE) when you start an activity or tap **Wake** on the device screen. Wake is **tested**; it is wake only — Melodious does not control the console afterwards.

## What it does (and does not do)

- **Supported — Nintendo Switch 2 wake:** Sends a 2-second BLE wake advertisement from the hub's `hci0` radio using a random BLE address (`Own_Address_Type = 0x01`) matching a controller already bonded to your Switch 2. The hub's public Bluetooth MAC and existing Bluetooth pairings (Apple TV, Shield, Google TV, etc.) are never modified.
- **Not supported — Nintendo Switch 1 wake:** Switch 1 uses a proprietary BR/EDR baseband RF handshake that the Harmony Hub's Bluetooth radio cannot transmit.
- **Not supported — controller / button control:** This feature is wake-only. Use your Joy-Con 2 or Pro Controller 2 to play once the console wakes.
- **Not supported — Switch 2 LAN wake:** Nintendo Switch 2 does not expose local LAN wake or control APIs.

## Requirements

- A **Nintendo Switch 2** console (tested on firmware `23.5.0`, docked and handheld).
- A **Joy-Con 2** or **Switch 2 Pro Controller** already paired (bonded) to that Switch 2.
- Your **Harmony Hub** within Bluetooth LE range of the Switch 2.

## Finding the two Bluetooth MAC addresses

Switch 2 only wakes when a wake advertisement carries both the **Switch 2's own Bluetooth MAC** and the **advertiser MAC of a controller already bonded to that console**. Only ever enter your own controller's MAC.

### Method 1: Phone BLE scanner app (nRF Connect or LightBlue)

1. Put your Switch 2 into **Sleep Mode** and keep a paired Joy-Con 2 or Pro Controller 2 nearby.
2. Open **nRF Connect** (Android/iOS) or **LightBlue** and start scanning. If the app supports filtering, filter by Manufacturer Data / Company ID `0x0553` (Nintendo, shown as `53 05` in raw bytes).
3. Press **HOME** on the paired controller (or detach a Joy-Con 2 while the console is asleep) and look for a short ~1.5 s advertisement whose raw manufacturer data starts with:
   ```text
   53 05 01 00 03 7E 05 <PID lo> <PID hi> 00 01 81 <6 reversed Switch 2 MAC bytes> 0F 00 ...
   ```
   *(If the console is awake, the flag byte is `00` instead of `81` — the rest of the fields are in the same positions.)*
4. Record the three values:
   - **Bonded controller MAC:** the advertising device's own Bluetooth MAC shown by the scanner (e.g. `12:34:56:78:9A:BC`).
   - **Controller type / PID:** the 2 bytes immediately after `7E 05`:
     - `66 20` — Joy-Con 2 (Right)
     - `67 20` — Joy-Con 2 (Left)
     - `69 20` — Switch 2 Pro Controller
   - **Switch 2 Bluetooth MAC:** the 6 bytes right after `00 01 81` (or `00 01 00`), **reversed back to normal byte order**. For example, payload bytes `33 22 11 CC BB AA` correspond to Switch 2 MAC `AA:BB:CC:11:22:33`. Enter it in normal order — Melodious handles the byte reversal inside the wake packet automatically.

### Method 2: Crowded RF rooms (computer BLE scan + hub `hcitool lescan`)

In rooms with dozens of ambient BLE advertisers (or on macOS, where CoreBluetooth hides raw advertiser MACs):

1. Run a passive BLE scan on a computer (for example with Python `bleak`) filtering for Company ID `0x0553` to read the manufacturer payload (`PID` and reversed Switch 2 MAC).
2. At the same time, run `hcitool -i hci0 lescan --passive --duplicates` on the hub over SSH while pressing **HOME** on the controller, and match the MAC that appears only during the ~1.5 s wake burst.

## Setup in Melodious

1. Open the **Web app** (`http://<hub-ip>:8080/`) or **Desktop app** and go to **Devices → + (Add a device)**.
2. Choose **Nintendo Switch 2 (Bluetooth wake)**.
3. Enter:
   - **Device name** (e.g. `Nintendo Switch 2`)
   - **Switch 2 Bluetooth MAC** (normal order, e.g. `AA:BB:CC:11:22:33`)
   - **Bonded controller MAC** (your paired controller's MAC)
   - **Controller type** (`Joy-Con 2 (Right)`, `Joy-Con 2 (Left)`, `Switch 2 Pro Controller`, or **Custom PID**)
4. Save the device, then test it by opening the device's **Commands** tab and tapping **Wake**.
5. Add the device to a **"Play Switch 2"** activity (for example under **Plays games**). Starting that activity from any Melodious remote or app fires the 2-second wake burst automatically; if the Switch 2 is docked with **Match TV Power State** enabled, waking the console also wakes the TV/AVR over HDMI-CEC as usual.

### Custom PID (advanced, untested)

Selecting **Custom PID** reveals a 2-byte hex field (in wire order, low byte first — the exact 2 bytes immediately after `7E 05` in the BLE manufacturer data). This path exists for third-party Switch 2 controllers such as PowerA, which have **not yet been hardware-tested** with Melodious.

## Why Power Off is a no-op

Nintendo Switch 2 does not accept an unencrypted BLE sleep beacon. Power Off for this device intentionally sends no command:

- **Docked:** Turning off your TV via your Harmony activity puts a docked Switch 2 to sleep automatically via HDMI-CEC (**System Settings → TV Output → Match TV Power State**).
- **Handheld / without CEC:** Put the console to sleep from the console or controller, or let its auto-sleep timer handle it.

Starting the Switch 2 activity twice in a row or tapping **Wake** manually while the console is already awake is harmless.

## Troubleshooting

- **Switch 2 does not wake at all:**
  - Confirm the Harmony Hub is within reliable BLE range of the Switch 2 (walls, metal racks, or cabinets can attenuate the 2-second beacon).
  - Double-check that the **Switch 2 Bluetooth MAC** was reversed back to normal order from the scanner payload (`33 22 11 CC BB AA` → `AA:BB:CC:11:22:33`).
  - Double-check that the **Bonded controller MAC** is the controller's own MAC (not the Switch 2's MAC) and that the controller is still paired to this Switch 2.
  - Check **Controller type**: Joy-Con 2 Right (`66 20`), Joy-Con 2 Left (`67 20`), and Pro Controller 2 (`69 20`) use different PIDs.
- **Wake fails with an HCI error:**
  - Verify `hci0` is `UP RUNNING` on the hub (`hciconfig hci0`). Melodious always disables BLE advertising even if a step fails and serializes overlapping wake bursts automatically.
