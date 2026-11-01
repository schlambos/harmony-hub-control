# Melodious web UI

The hub web UI follows the native Android app (`Android/`, Kotlin + Jetpack
Compose, Material 3, dark): it looks, navigates and feels like it, under one
brand. It's a full interface port (layout, navigation, components, type,
colour, icons, motion), not a recolour.

Limits:
- The backend doesn't change: same hub routes and request shapes, no new C
  routes.
- Everything stays embedded in `codex_webui`: no CDN, no web fonts, no new
  served files.

## Brand

- **Product name: Melodious** (it matches the app's
  `app_name`, its package `app.melodious` and the branding files).
- Where it appears in the web UI: page title, header, per-view titles
  (`Remote · Melodious`), meta description, the default Bluetooth keyboard
  name shown on the TV, and `DESIGN.md`.
- Unchanged:
  - "Harmony Hub" and "Harmony Touch" as device names;
  - the repo `schlambos/harmony-hub-control`, binaries, paths, API routes;
  - the installers, `README.md` (they name the project, not the product);
  - the legacy page built into `codex_webui.c`.
- Icon: made from `Android/branding/melodious-icon-source.jpg` using the same
  numpy glyph extraction as `build_icon.py`: the neon glyph on the charcoal
  tile with rounded corners. Only the output PNGs come into the repo, not
  the scripts or the artwork.
  - Favicon: 64 px PNG, about 3.7 KB, inlined in the page head (about 5 KB
    as a data URI).
  - Optional home-screen icon (`apple-touch-icon` for iOS "Add to Home
    Screen"; Chrome for Android can fall back to it): 180 px, about 15.7 KB
    (about 21 KB inline).
  - No PWA manifest. It would need its own route, and the hub sends every
    asset `no-store` and uncompressed, so anything inlined is paid on every
    page load.

## Navigation

Four tabs, as in the app. Phones get a bottom navigation bar. Screens
840 px and wider get a Material navigation rail on the left, with the
content centred.

| Tab | Hash | What it holds | Old hashes that land here |
| --- | --- | --- | --- |
| Remote | `#remote` | "Everything's off" picker, running-activity remote | `#control`, `#home` |
| Activities | `#activities` | list, setup wizard (`#wizard`), advanced editor (`#editor`) | (unchanged) |
| Devices | `#devices` | device list, then a device page (remote, commands, settings, learn, import) and the IR tools | `#ir` |
| Settings | `#settings` | hub status, Remotes, Bluetooth, MQTT, Wi-Fi, Backup, System | `#bluetooth` `#mqtt` `#wifi` `#backup` `#system`, kept as sub-pages; `#remotes` is new |

- Sub-pages get the app's top bar (back arrow and title). Back returns to
  the tab they belong to.
- Old hashes keep working, so bookmarks survive.
- The router has path arguments: `#devices/<id>`, `#devices/<id>/settings`,
  `#devices/<id>/sweep`, `#devices/lab`, `#remote/<activityId>`,
  `#wizard/<id>`.

## Screen map

| Android (`ui/…`) | Web after the port |
| --- | --- |
| `remote/RemoteScreen` OffState | Remote tab when nothing runs: "Everything's off · What do you want to do?" with one card per activity (tap starts it). Replaces Home's Start tiles. |
| BusyState | Remote tab while starting or stopping ("Starting Watch TV…") |
| ActivityRemote + RemoteHeader | Running activity: name (tap opens a switch-activity sheet with "Turn everything off"), device line with live dot, power button |
| RemoteModeTabs + ButtonsSurface | Buttons surface: transport row, D-pad, VOL and CH rockers, Back/Menu/Exit/Mute |
| MoreKeysSheet + AllCommandsPage | "More keys" sheet: this activity's on-screen buttons; Guide/Info/DVR/Exit; Record/Stop and colour keys; number pad; all device commands |
| TouchpadSurface | — (not chosen) |
| KeyboardSurface | Keyboard tab: text and keys to the hub's Bluetooth keyboard (`/api/bt-text`, `/api/bt-call`, the same as the Bluetooth page) |
| FixItSheet | Fix-it sheet: per-device "It's off" / "Switch to HDMI 1" resend through `/api/ir-send` |
| SleepTimerPill/Sheet | — (Android-only, see below) |
| `devices/DevicesScreen` DevicesTab | Devices tab: search devices or commands; grouped list with icon, model, command count and IR/Bluetooth badge |
| DeviceDetailScreen | Device page with Remote and Commands tabs (tap a command to send it; search); ⋮ Make, Rebuild or Remove Touch screen |
| Learn and Import sheets | Learn a button, Import codes (Find codes, Paste, Type a code) |
| `devices/DeviceSettingsScreen` | Device settings page: Power, Turning on, Inputs (web-only), Timing |
| `activities/ActivitiesScreen` | Activities tab: running card, rows with Start and a ⋮ menu (Edit, Set up buttons, Try the buttons, Advanced editor, Move up / down, Delete) |
| ActivityEditor (5 steps) | Wizard restyled as the app's step screens: Name, Devices, Inputs, Buttons, Review. The app's "Start & end" step is parity item P2, not part of the port. |
| TouchScreenEditor | — (parity item P3; the advanced editor still covers on-screen buttons) |
| `settings/SettingsScreen` | Settings tab: hub card, then rows for Bluetooth keyboard, MQTT, Wi-Fi, Backup, System |
| BluetoothScreen | Bluetooth page |
| AdvancedScreen | Hub status → System page. Recent commands → send log. IR sweep → Devices. |
| HubConnectScreen / ConnectGate | — (the hub serves the page; there's nothing to discover) |

## Tokens: `MelodiousTheme.kt` → `tokens.css`

| Compose | Value | CSS custom property |
| --- | --- | --- |
| `MelodiousColors.Canvas` (background, surface) | `#0E1014` | `--canvas` |
| `NavBar` (surfaceContainerLow) | `#15181D` | `--nav-bar` |
| `Card` (surfaceContainer) | `#171A20` | `--card` |
| `Key` (surfaceVariant) | `#1F232B` | `--key` |
| `KeyRaised` | `#2A2F39` | `--key-raised` |
| `DPadRing` | `#1A1E25` | `--dpad-ring` |
| `Divider` | `#22262E` | `--divider` |
| `Live` | `#6FD3A8` | `--live` |
| `Warning` | `#F2C48D` | `--warning` |
| `PowerContainer` / `OnPowerContainer` | `#3A1F1F` / `#FFB4AB` | `--power-container` / `--on-power-container` |
| `RunningCard` | `#1D2840` | `--running-card` |
| `KeyRed` `KeyGreen` `KeyYellow` `KeyBlue` | `#F06A6A` `#5FD08B` `#F2D25C` `#6AA2F5` | `--key-red` … `--key-blue` |
| primary / onPrimary | `#9DB8FF` / `#0B1A3A` | `--primary` / `--on-primary` |
| primaryContainer / on | `#2B3A5E` / `#D9E2FF` | `--primary-container` / `--on-primary-container` |
| secondary / onSecondary | `#BEC6DC` / `#283141` | `--secondary` / `--on-secondary` |
| tertiary / onTertiary | `#8FE0BC` / `#003828` | `--tertiary` / `--on-tertiary` |
| onSurface / onSurfaceVariant | `#E7E9EE` / `#A3AAB7` | `--on-surface` / `--on-surface-variant` |
| surfaceContainerLowest / High / Highest | `#0A0B0E` / `#1A1D23` / `#262A33` | `--surface-lowest` / `--surface-high` / `--surface-highest` |
| outline / outlineVariant | `#4A505C` / `#343A46` | `--outline` / `--outline-variant` |
| error / onError | `#FFB4AB` / `#690005` | `--error` / `--on-error` |
| inverseSurface / inverseOnSurface / inversePrimary | `#E2E2E9` / `#2F3036` / `#3F5A9A` | `--inverse-surface` / `--inverse-on-surface` / `--inverse-primary` |
| Shapes xs/sm/md/lg/xl | 8 / 12 / 16 / 24 / 28 dp | `--shape-xs` … `--shape-xl`, plus `--shape-full` |

Colours the screens use inline (icon tiles `#262A33` on `#C3C8D2`, activity
tiles `#23302A` on `#A8E6C8`, the hub tile `#1E3329`, the sheet key
`#262A33`, the keyboard warning `#2E2718`) get named tokens too.

The old token names (`--surface-*`, `--accent-*`, `--status-*`, `--key-face`
…) stay as aliases onto the new palette until every view is ported, then
they're removed. This is the same trick `tokens.css` already uses for the
vendored editor.

Type uses the system font stack: Roboto on Android (the app's own font), SF
on Apple, Segoe on Windows. That costs 0 bytes. Sizes follow the app:

| Use | Size and weight |
| --- | --- |
| Screen title | 28/36 medium |
| Remote title | 24 medium |
| Card title | 22 medium |
| Sheet title | 20 medium |
| Row title | 16–18 |
| Buttons | 15 |
| Section label | 14 medium, primary |
| Subtitle | 13 |
| Caption | 12 |
| Overline | 11–12 semibold, +0.8 tracking ("RUNNING NOW", "VOL") |

## Components

| Compose | Web |
| --- | --- |
| ScreenTitle, SectionLabel | `.m-title` (28 px, optional subtitle and action), `.m-section` |
| ListGroup / ListRow / GroupDivider / SwitchRow | `.m-list` (24 px radius on `--card`, hairline dividers), `.m-row` (min 64 px, chevron), `.m-switch` (a checkbox with `role="switch"`) |
| IconTile, StatusDot, PowerButton | `.m-tile`, `.m-dot`, `.m-power` |
| Buttons: filled, tonal, outlined, text, icon | `.btn` family restyled as pills (40–52 px); the `.btn-primary` etc. class names stay so unported views follow |
| DetailPage / TopAppBar | shell top bar for sub-pages |
| ModalBottomSheet | `<dialog class="m-sheet">`: 28 px top corners, drag handle, scrim, Esc and scrim-tap close it; centred card on wide screens |
| ConfirmDialog | `<dialog class="m-dialog">` through `confirmDialog()`; Cancel has focus first. The existing inline danger guards stay where a typed phrase is needed. |
| DropdownMenu | `<dialog class="m-menu">` through `openMenu()`: dropped from its button, arrow keys move, Esc and a click outside close it |
| Snackbar | `.m-snackbar` (inverse surface), errors linger |
| FilterChip / AssistChip | `.m-chip` |
| EmptyState | `.m-empty` |
| KeyButton, IconKey, TextKey, CaptionKey, DPad, Rocker, ColorKey | `.rk-*` remote keys (a native keypad, no photo) |
| Material icons | inline SVG paths for the roughly 40 Material Symbols the app uses (Apache-2.0; licence goes in `third_party/`) |

## Behaviour carried over

- Plain keys fire on release.
- Keys with a hold action fire it after 500 ms (the web used 550 ms).
- Unmapped keys dim to 35% and do nothing.
- Volume, channel and the
  D-pad fire on touch-down and, held, repeat through the hub's native
  press-and-hold: `/api/ir-send` with `status` press, hold every 200 ms and
  release, and a `holdId`. The hub runs the hold over one engine connection
  and repeats from 380 ms, as the app does.
- Menu or Exit is relabelled "Home" when it really sends Home.
- The remote's Back key is stored as `PrevChannel`, and the wizard lets you
  set it like any other key, as the app does (approved 2026-10-21).
- Phones get a short vibration where the browser supports it; desktops get a
  pressed state.
- Errors show as a snackbar.
- The web's resolved "device · command" line stays as a quiet status line
  under the mode tabs. On desktop it also shows a preview on hover or focus.
- Keyboard and screen readers: every key and row is a real button with a
  label and a visible focus ring. Sheets trap focus and close on Esc.
- With `prefers-reduced-motion`, sheets and views appear without sliding.

## Android-only (not portable to a web page)

- Home-screen widget, Quick Settings tile, notification remote, lock-screen
  controls, `melodious://` deep links.
- Phone volume rocker, and the "This phone" settings that go with it.
- The app's keyboard and voice drawer. The web keyboard surface uses the
  phone's own keyboard, whose mic button dictates.
- SSH recovery (`core-ssh`); hub discovery and the connect screen.
- Anything else on the stock :8088 bus: the sleep timer, "Resend
  everything" (hub Help), instant state push. (Native press-and-hold now
  goes through `/api/ir-send`, which relays it to the bus.) That bus wants a
  Logitech `Origin` header, which a browser can't send. Reaching it would
  need a hub-side proxy route, which is a backend change. The web keeps
  polling `/api/state`.

## Web-only (the app lacks these; they stay, restyled)

- **Settings pages:**
  - Wi-Fi;
  - MQTT;
  - Backup: owner bundle, single exports, restore with typed guards;
  - System: status, logs, cloud blocker, time zone, sign-in, software
    update, HA rediscovery, reboot.
- **IR tools:**
  - add, edit and delete devices;
  - add, edit and delete commands, including signal details;
  - capture, test and save (Learn);
  - batch sweep with dry run and cancel;
  - Find codes (IRDB search and preview, file drop);
  - paste import; RemoteCentral fetch; the IR lab.
- **Bluetooth:** scan, connect, disconnect, adapter status, 30 quick keys
  and custom combos, saved devices with keyboard-script commands.
- **Activities:**
  - reorder (Move up and Move down in the ⋮ menu);
  - the vendored advanced editor;
  - pressing a non-running activity's keys. This stays as "Try the buttons"
    in the activity menu, which opens `#remote/<id>` without starting it.
- **Remote:** the send log, the resolved command for every key, and "All
  commands".
- **Wizard:**
  - the review step;
  - "Don't switch" among a device's inputs;
  - a key's hold action (a Press / Hold tab in the button picker);
  - the wait after a device turns on, on the Devices step. The app keeps
    it in its "Start & end" step, which is parity item P2.
