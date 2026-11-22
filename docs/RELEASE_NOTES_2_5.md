# Melodious 2.5

Melodious 2.5 is the first full release since 2.0. (2.1 was 2.0 with a fix for the Windows
installer.) It adds a guided setup in the desktop app, more remote and device options, a Windows
desktop app, and fixes for the problems people reported.

Some parts are less tested than others. Each one is labelled where it is described, and
[Known limitations](#known-limitations) lists what has only been checked by automated tests.

## What you will notice

- **Guided setup.** The desktop app's Setup Wizard takes a hub that is new, factory reset,
  second-hand or already set up, and leaves it rooted and running Melodious. No commands and no
  Logitech account. Tested on macOS with a real hub. On Windows and Linux: **Not fully tested,
  needs confirmation**. See the [Setup Guide](SETUP_GUIDE.md).
- **Saving works the first time.** The first Save after opening an editor no longer fails and
  then works on the second try.
- **More buttons you can set.** The Home Control buttons on Companion, Elite and 950 remotes, the
  `--` and `E` keys on remotes without a screen, and a number pad on new activities for remotes
  with a screen.
- **New kinds of device.** Nintendo Switch 2 wake (**tested**), saved Bluetooth keyboards, and
  LG webOS TVs over the network (**experimental**).
- **Logitech catalog codes that used to be skipped now import.** Codes that need an IR protocol
  the hub did not have, such as some Samsung soundbars, bring the protocol with them.

## What's new

### Setup and install

- **Setup Wizard** in the desktop app. It finds the hub, joins it to Wi-Fi, roots it and installs
  Melodious. It opens on first launch and is also in Settings.
- **Fresh hubs with no Logitech account.** The root tool is bundled in `tools/hub-root/` and can
  activate a factory-fresh hub offline from the command line on Windows, Linux and macOS
  ([guide](FRESH_HUB_ACTIVATION.md)).
- **Reinstall / repair hub software** in the desktop app (Settings → Updates). Repair replaces
  only the files that differ. Reinstall All Files rewrites them all. Tested on macOS and Windows.
- **`--turn-off` and `--turn-on`** (**experimental**) in the installers. Turn-off hands the hub
  back to Logitech's own software and keeps Melodious's files. Turn-on brings Melodious back. Not
  yet validated on a real hub, so back up first ([details](INSTALL.md#turn-melodious-off-and-on)).
- The installer warns when an old Harmony Hub Extender package is using the hub's storage (#118).
- **Time servers.** Set up to three NTP servers in System, or with `--ntp-server` (@mirsadone).
- **`busybox-extra`.** 63 newer command-line tools on the hub for diagnostics (@apnar).

### Remotes

- **Two remotes with a screen on one hub**, with `--two-screen` in the installers. Tested with a
  Touch and a 950, and confirmed by a user with two Ultimates and a Companion. It is off unless
  you turn it on, and needs firmware 4.15.600 ([guide](TWO_SCREEN_REMOTES.md)).
- **Several remotes without a screen of the same model** (multi-remote, **experimental**), in
  Settings → Experimental. Needs firmware 4.15.600 (@apnar, [guide](MULTI_REMOTE.md)).
- **Home Control buttons** on Companion (@Mugga6315), Elite and 950 (#154, #192). The buttons and
  the `+`/`-` rocker can run any command, in one activity or in all of them. Old Logitech
  assignments can be replaced or cleared ([guide](HOME_CONTROL_BUTTONS.md)).
- **Background picture** for remotes with a screen (@Bergasha, [guide](REMOTE_BACKGROUNDS.md)).
- The `--` and `E` keys on Smart Control and Companion remotes can be assigned (#234).
- New activities get a number pad from any device in the activity, and a digit can have a hold
  command (#191, #190).
- A remote's clock follows the time zone saved in System when the hub is offline (@jrx-code).
- New guide: [moving a remote with a screen to a new hub](ACTIVITIES_GUIDE.md#moving-a-remote-with-a-screen-to-a-new-hub)
  (@apnar).

### Devices

- **Nintendo Switch 2 wake** (**tested**). The hub wakes a sleeping Switch 2 over Bluetooth when
  an activity starts. It only wakes the console and does not control it. Controllers with their
  own IDs, such as PowerA, are untested ([guide](SWITCH2_WAKE.md)).
- **LG webOS TVs over the network** (**experimental**), without Home Assistant or IR. It has
  known problems on some newer LG TVs, such as 2024 (webOS 24) models ([guide](WEBOS_TV.md)).
- **Android TV and Google TV.** Choose how each TV switches inputs in Settings → Inputs, with a
  Try button. Wake-on-LAN reaches TVs on every network the hub is on, and Hisense inputs switch
  correctly (@apnar, [guide](ANDROID_TV.md)).
- **Saved Bluetooth keyboards as devices.** A saved Bluetooth keyboard target can be a device in
  activities and on buttons, and its saved scripts become commands (#114, started by
  @OrganoidSchnitzel, [guide](BLUETOOTH_KEYBOARD.md)).
- **IR output per device.** Send a device's commands from the hub, either blaster, all of them,
  or the remote's own emitter (@mirsadone).
- **Logitech catalog.** An import brings the IR protocol with it when the hub lacks it (#243),
  and imports work on a blank hub.
- **Wired network over USB Ethernet** (**experimental**), in Settings → Experimental. Tested with
  Realtek RTL8153 and ASIX AX88772C adapters only (@apnar, [guide](USB_ETHERNET.md)).

### Activities

- **Time restrictions.** Block an activity from starting on the days and times you choose
  (@danielvijge, [guide](ACTIVITIES_GUIDE.md)).
- The command picker stays usable with many devices and searches across all of them (#216).

### Apps

- **Desktop app for Windows** 10/11 x64, and Linux from source: **Not fully tested, needs
  confirmation**. The Windows app is unsigned, so SmartScreen warns before the first launch
  ([guide](DESKTOP_APP.md)).
- **iPhone and iPad app** (**experimental, sideload only**). It starts activities and works as a
  remote, with no editors. Install the `.ipa` with AltStore or SideStore, or build it in Xcode
  ([guide](IOS_APP.md)).
- **Android app.** It follows the hub features above: IR output, input methods, the new device
  types, the command picker and the new keys.

### Home Assistant

- The [integration](https://github.com/schlambos/ha-melodious) is at 0.7.3. Single entities are
  sent beside whole devices (#162). Hue devices with long or quoted model names, or with many
  entities, no longer make the hub refuse a push. Accented command names keep their letters. The
  `via_device` warning on Home Assistant 2026.11 is gone (#202).
- When a push leaves out a device that an activity or button still uses, the hub keeps the
  device and accepts the rest. Home Assistant shows a notice that names it.

## What's fixed

### Saving and editing

- The first Save after opening an editor failed with a conflict error (#218).
- Saving in the Advanced Editor failed with "references missing sequence" (#201).
- Old Logitech button maps with duplicate menu positions blocked unrelated edits (#178), and
  editing an imported start or stop sequence failed (#189, #193).
- Imported commands named like `VOLUME +` and `VOLUME -` now map to volume up and down
  (@jrx-code).

### Remotes

- Imported Logitech activities did not answer the remote until they were saved again, and a
  remote paired after the activities existed got no buttons (#86).
- A new activity on a hub that only ever had a remote with a screen got no buttons for that
  remote (#250). See [Upgrade notes](#upgrade-notes).
- A Harmony Ultimate no longer stalls at 58% when it syncs offline (#180). One that was never
  activated with Logitech is no longer stuck on the setup screen (#219, with @jrx-code).

### Hub and installers

- A blank hub, or one cut off from the cloud, runs its first activity without an extra restart
  (#172).
- With the cloud blocker on, the hub now checks its Wi-Fi link and rejoins when it drops (#202).
- System → Logs hides routine status polls and says its times are UTC (#194).
- The hub software no longer stops at startup on firmware 4.11.6 (#176, with @jupbek).
- The PowerShell installer runs on Windows PowerShell 5.1 (#139, also in 2.1).
- The Setup Wizard reports a download or unpack problem as that, and no longer blames the USB
  cable.
- The hub's programs are about 310 KB smaller (@apnar).

## How to update

Your devices, activities, button assignments and settings are kept.

1. **Hub.** Download `melodious-hub-2.5.0.zip` from the
   [release page](https://github.com/schlambos/harmony-hub-control/releases), unzip it, and run
   the installer again:
   - Windows: double-click `Install_Harmony_Control.cmd`, or run
     `.\install_webui.ps1 -HubHost <hub-ip>`.
   - Linux and macOS: `python3 install_webui.py --hub-host <hub-ip>`.

   The hub restarts once at the end. If the installer stops with `BLOCKED_CAPACITY`, see
   [If the hub's flash is full](INSTALL.md#if-the-hubs-flash-is-full).
2. **Desktop app.** Install the 2.5 app over the old one. To update the hub from the app instead
   of step 1, install the 2.5 app first, then use Settings → Updates → **Update hub…**.
3. **Android app.** Install `melodious-2.5.0.apk` over the old one.
4. **Home Assistant.** Update the Melodious integration to 0.7.3 in HACS.

[INSTALL.md](INSTALL.md#updating) has the details, and how to roll back.

## Upgrade notes

- **Activities made on 2.1.0 or older, on a hub that only ever had a remote with a screen (for
  example an Elite), need one re-save.** Open the activity's wizard in the web or desktop app and
  save it once. Until then the remote's buttons do nothing in that activity (#250).
- The 2.5 desktop app needs a 2.5 hub zip. Reinstall / repair and the Setup Wizard refuse the zip
  from an older release.

## Known limitations

**Labels in this release**

| Feature | Status |
| --- | --- |
| Nintendo Switch 2 wake | Tested |
| Desktop app and Setup Wizard on Windows and Linux | Not fully tested, needs confirmation |
| LG webOS TVs over the network | Experimental |
| `--turn-off` and `--turn-on` | Experimental |
| Multi-remote | Experimental |
| USB Ethernet | Experimental |
| iPhone and iPad app | Experimental, sideload only |

**Checked by automated tests only, not yet on real hardware**

- Saving: the first-Save fix (#218) and the faster save check that followed it (#224).
- Logitech catalog imports that bring an IR protocol with them (#243).
- Saved Bluetooth keyboards as devices, and their scripts as commands (#114).
- Button fixes for imported activities and for remotes paired later (#86), and for hubs with
  only a remote with a screen (#250).
- The full first sync of a never-activated Harmony Ultimate (#219). The start of it is confirmed
  by a user, the rest is not.
- Old Logitech maps with duplicate menu positions (#178), and hold commands on digits (#190).
- The `--` and `E` keys (#234) and the command picker layout (#216).
- Firmware 4.11.6 support as merged (#176). The original patch ran on a 4.11.6 hub.
- The Extender package warning in the installer (#118).
- The Home Assistant changes after integration 0.7.2, on the hub and in the integration.
- Android: this release's changes are built and unit tested, not run on a phone.
- iPhone: run in the simulator only. The app was tested on an iPad. Installing the `.ipa` with
  AltStore or SideStore has not been checked.

**Other limits**

- LG webOS: the fixes for 2024 LG TVs are not in 2.5. Use Home Assistant or IR for those TVs.
- USB Ethernet: plugging a Realtek RTL8153 adapter into a running hub restarted the hub in
  testing. The cause looks like power delivery and is not settled.
- A remote's clock offline: the hub reports the saved time zone, but the clock on a remote's
  screen has not been checked.
- Harmony 950: long press, per-activity assignments and holding the rocker have not been tested
  on a 950.
- Android TV, Switch 2 and LG webOS devices are added from the web or desktop app. The Android
  app controls them but cannot add them.

## Credits

Thank you to everyone who sent code, tested builds or reported a problem for this release:

@apnar, @Bergasha, @boomfunks, @danielvijge, @deluxestyle, @dramatic-paws, @iranl, @jdeath,
@jluc2808, @jrx-code, @jupbek, @keanemachine, @legoleigh, @mdeyssen, @mfazio11, @mirsadone,
@Mugga6315, @nohjyk-art, @OrganoidSchnitzel, @SanguShellz, @ScottishB, @StreneSaco, @sumps71,
@thre3eye, @Thorhammer1967, @timothyallan, @TOMSTR3, @Triskae, @uefigs139
