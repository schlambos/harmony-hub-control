# Melodious 2.5

Melodious 2.5 is the first full release since 2.0. (2.1 was 2.0 with a fix for the Windows
installer.) You can now set up a brand-new hub without Logitech at all, run two screen remotes on
one hub at the same time, and customise far more of every remote. There's a Windows desktop app,
and fixes for the problems people reported.

Some parts are less tested than others. Each one is labelled where it is described, and
[Known limitations](#known-limitations) lists what has only been checked by automated tests.

## What you will notice

- **Set up a hub with no Logitech at all.** The desktop app's Setup Wizard takes a hub that is
  new, factory reset, second-hand or already set up, provisions it locally, roots it and leaves it
  running Melodious, fully offline. No Logitech account, app or cloud, and no commands. Tested on
  macOS and Windows with real hubs. On Linux: **Not fully tested, needs confirmation**. See the
  [Setup Guide](SETUP_GUIDE.md).
- **Two screen remotes at once.** Run a Touch and a 950, or two Ultimates, on one hub, kept in sync
  ([guide](TWO_SCREEN_REMOTES.md)).
- **More of every remote is yours.** The Home Control buttons on Companion, Elite and 950 remotes,
  your own backgrounds on screen remotes, the `--` and `E` keys on remotes without a screen, and a
  number pad on new activities for remotes with a screen.
- **Saving works the first time.** The first Save after opening an editor no longer fails and
  then works on the second try.
- **New kinds of device.** Saved Bluetooth keyboards and LG webOS TVs over the network
  (**experimental**).

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
- **Time servers.** Set up to three NTP servers in System, or with `--ntp-server` (@mirsadone).
- **`busybox-extra`.** 63 newer command-line tools on the hub for diagnostics (@apnar).

### Remotes

- **Two remotes with a screen on one hub**, with `--two-screen` in the installers. Tested with a
  Touch and a 950, and confirmed by a user with two Ultimates and a Companion. It is off unless
  you turn it on, and needs firmware 4.15.600 ([guide](TWO_SCREEN_REMOTES.md)).
- **Several remotes without a screen of the same model** (multi-remote, **experimental**), in
  Settings → Experimental. Needs firmware 4.15.600 (@apnar, [guide](MULTI_REMOTE.md)).
- **Home Control buttons** on Companion (@Mugga6315), Elite and 950 (#154, #192). The buttons and
  the `+`/`-` rocker can run any command, in one activity or in all of them
  ([guide](HOME_CONTROL_BUTTONS.md)).
- **Background picture** for remotes with a screen (@Bergasha, [guide](REMOTE_BACKGROUNDS.md)).
- A digit on the number pad can have a hold command (#190).
- New guide: [moving a remote with a screen to a new hub](ACTIVITIES_GUIDE.md#moving-a-remote-with-a-screen-to-a-new-hub)
  (@apnar).

### Devices

- **LG webOS TVs over the network** (**experimental**), without Home Assistant or IR. It has
  known problems on some newer LG TVs, such as 2024 (webOS 24) models ([guide](WEBOS_TV.md)).
- **Android TV and Google TV.** Choose how each TV switches inputs in Settings → Inputs, with a
  Try button (@apnar, [guide](ANDROID_TV.md)).
- **Saved Bluetooth keyboards as devices.** A saved Bluetooth keyboard target can be a device in
  activities and on buttons, and its saved scripts become commands (#114, started by
  @OrganoidSchnitzel, [guide](BLUETOOTH_KEYBOARD.md)).
- **IR output per device.** Send a device's commands from the hub, either blaster, all of them,
  or the remote's own emitter (@mirsadone).
- **Wired network over USB Ethernet** (**experimental**), in Settings → Experimental.
  Tested with Realtek RTL8153 and ASIX AX88772C adapters (@apnar, [guide](USB_ETHERNET.md)).
- **Nintendo Switch 2 wake** (**tested**, wake only). Controllers with their own IDs, such as
  PowerA, are untested ([guide](SWITCH2_WAKE.md)).

### Activities

- **Time restrictions.** Block an activity from starting on the days and times you choose
  (@danielvijge, [guide](ACTIVITIES_GUIDE.md)).

### Apps

- **Desktop app for Windows** 10/11 x64, tested with a real hub, and Linux from source (**Not
  fully tested, needs confirmation**). The Windows app is unsigned, so SmartScreen warns before the first launch
  ([guide](DESKTOP_APP.md)).
- **iPhone and iPad app** (**experimental, sideload only**). It starts activities and works as a
  remote, with no editors. Install the `.ipa` with AltStore or SideStore, or build it in Xcode
  ([guide](IOS_APP.md)).
- **Android app.** It follows the hub features above: IR output, input methods, the new device
  types, the command picker and the new keys.

### Home Assistant

- The [integration](https://github.com/schlambos/ha-melodious) is at 0.7.3. Its fixes are listed
  under [What's fixed](#home-assistant-1).

## What's fixed

### Saving and editing

- The first Save after opening an editor failed with a conflict error (#218, @jluc2808).
- Saving in the Advanced Editor failed with "references missing sequence" (#201, @jluc2808).
- Old Logitech button maps with duplicate menu positions blocked unrelated edits (#178,
  @TOMSTR3).
- Editing an imported start or stop sequence failed (#189, #193, @jluc2808).
- The command picker got too small to use with many devices. It now scrolls and searches across
  all of them (#216, @jluc2808).
- Imported commands named like `VOLUME +` and `VOLUME -` were not put on the volume buttons
  (#239, @jrx-code).

### Remotes

- Imported Logitech activities did not answer the remote until they were saved again, and a
  remote paired after the activities existed got no buttons (#86, @dramatic-paws,
  @danielvijge).
- Activities whose remote buttons did nothing on hubs that only had a remote with a screen are
  repaired automatically when you update, and new activities get the remote's buttons right away
  (#250, @ScottishB).
- New activities on an Elite had no number pad (#191, @jluc2808).
- Home Control buttons that Logitech had set up showed "Set up elsewhere" and could not be
  changed or cleared (#154, @StreneSaco).
- The `--` and `E` keys on Smart Control and Companion remotes could not be assigned (#234,
  @danielvijge).
- With the hub offline, a remote's clock ignored the time zone saved in System (#236,
  @jrx-code).
- A Harmony Ultimate stalled at 58% when it synced offline (#180, @thre3eye).
- A Harmony Ultimate that was never activated with Logitech was stuck on the setup screen
  (#219, @jrx-code).

### Hub and installers

- A hub that had never been set up could not open the editors, and its remote's activity button
  did nothing (#134).
- A rooted hub that had lost its Logitech account could not be set up from the apps (#172,
  @keanemachine).
- With the cloud blocker on, the hub did not rejoin Wi-Fi when the connection dropped (#202,
  @jluc2808).
- System → Logs was flooded with routine status polls and did not say its times are UTC (#194,
  @jluc2808).
- The hub software stopped at startup on firmware 4.11.6 (#176, @jupbek).
- The PowerShell installer failed with syntax errors on Windows PowerShell 5.1 (#139,
  @nohjyk-art, @mfazio11).
- The installer could stop for lack of room when the space was held by leftovers from older
  installs and the root tool. It now removes them itself, so `--remove-root-tool-leftovers` is
  still accepted but no longer needed (#258).
- The installer counted the root tool's SSH program as spare space even when Melodious shared
  it, so removing it freed nothing (#133, @apnar).
- When an old Harmony Hub Extender package filled the hub's storage, the installer said there
  was no room without saying why (#118, @danielvijge).
- Importing from the Logitech catalog on a blank or factory-reset hub skipped every command
  (#217).
- Logitech catalog devices whose IR protocol the hub did not have, such as some Samsung
  soundbars, could not be imported (#243, @timothyallan).
- Wake-on-LAN did not wake an Android TV or Google TV from deep standby while the cloud blocker
  was on (#113, @apnar).
- Hisense TVs did not switch inputs, and a TV that was turning off or waking up could miss the
  power-on or the input (#136, @apnar).
- The USB Ethernet code was missing the copyright notice for the harmony-ng work it builds on
  (#129, @iranl).
- The hub's programs are about 310 KB smaller (#131, @apnar).

### Home Assistant

- Single entities, such as scripts and buttons, were not sent to the hub when whole devices
  were also chosen (#162, @legoleigh).
- A Hue device with a quoted or long model name, or with many entities, made the hub refuse the
  whole push (#162, @legoleigh, @StreneSaco).
- After the hub was removed and added again in Home Assistant, its devices' commands got broken
  names (#162, @legoleigh, @StreneSaco).
- When a push left out a device that an activity or button still used, the hub refused the
  whole push. It now keeps that device, accepts the rest, and Home Assistant names it in a
  notice (#162, #210, @StreneSaco, @legoleigh).
- A Hue room could come back as a different device after a push (#162, @StreneSaco).
- Accented command names lost letters, so `Détente` became `Dtente` (#162, @StreneSaco).
- Newer Home Assistant versions logged a `via_device` deprecation warning for every mirrored
  device (#202, @jluc2808).

### Apps

- The desktop app's Update hub refused every released hub zip (#155).

### Also fixed in pre-release builds from main

Some people ran `main` before this release and hit these. None of them were in an earlier
release.

- Saving restarted the hub and disconnected the app (#224, @jluc2808).
- On some hubs every Save was refused as a conflict (#225, @jrx-code).
- On a hub that had never been set up, the first activity failed until the hub was restarted,
  while the app showed it as running (#165).
- The Setup Wizard could lose the hub over USB after a restart and stop partway through (#169).
- The Setup Wizard's install step blamed the USB cable for download and unpack problems (#242).
- On Windows, the Setup Wizard hung while setting up local hub access over USB, and Try again
  could not recover it (#268).
- The desktop app refused the 2.5 hub zip, and installing on a freshly erased hub stopped
  partway (#268).
- Switch 2 wake failed with an error and the console stayed asleep (#200).
- With Wi-Fi off and the hub on USB Ethernet, Wake-on-LAN did not reach the TV (#126, @apnar).
- Handing the network back from USB Ethernet to Wi-Fi broke the wired connection until it
  restarted (#128, @apnar).
- The extender light could show the wrong Ethernet state if the Ethernet service stopped in the
  middle of a change (#143, @apnar).

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

- Activities whose remote buttons did nothing on hubs that only had a remote with a screen are
  repaired automatically when you update (#250).
- The 2.5 desktop app needs a 2.5 hub zip. Reinstall / repair and the Setup Wizard refuse the zip
  from an older release.

## Known limitations

**Labels in this release**

| Feature | Status |
| --- | --- |
| Nintendo Switch 2 wake | Tested |
| Desktop app and Setup Wizard on Windows | Tested |
| Desktop app and Setup Wizard on Linux | Not fully tested, needs confirmation |
| LG webOS TVs over the network | Experimental |
| `--turn-off` and `--turn-on` | Experimental |
| Multi-remote | Experimental |
| USB Ethernet | Experimental |
| iPhone and iPad app | Experimental, sideload only |

**Checked by automated tests only, not yet on real hardware**

- Importing Logitech catalog codes the hub didn't know before, such as some Samsung soundbars
  (#243).
- Saved Bluetooth keyboards as devices, and their scripts as commands (#114).
- Button fixes for imported activities and for remotes paired later (#86), and for hubs with
  only a remote with a screen (#250).
- The full first sync of a never-activated Harmony Ultimate (#219). The start of it is confirmed
  by a user, the rest is not.
- Old Logitech maps with duplicate menu positions (#178), and hold commands on digits (#190).
- The command picker layout (#216).
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
