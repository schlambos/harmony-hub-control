# Melodious 2.5

* **iPhone and iPad: [BLOCKED — not in this build]** The experimental app is still in PR #196. It requires sideloading. With a free Apple account, signing needs to be refreshed every seven days.
* **Switch 2: [BLOCKED — not in this build]** Wake support has not landed. It is for waking the console only, not controlling games or menus.
* **Number pads:** The Touch editor now finds digits on devices in the activity, and you can assign a hold command to a digit.
* **Home control:** Assign the home control buttons on Companion, Elite and 950 remotes. On the Elite and 950, the editor shows the buttons in their physical order. You can clear or replace an old binding.
* **Home Assistant:** Old Logitech button maps no longer block unrelated edits just because they already contain duplicate menu positions. The separate Home Assistant integration change in PR #18 is not included. We have not confirmed a fix for repeated syncs.
* **Firmware 4.11.6: [BLOCKED — not in this build]** Issue #176 remains open. Do not rely on this build for compatibility with that firmware.

## Other changes

* Upload a background picture to a screen remote without the cloud.
* A blank hub can start its first activity, and offline setup supplies the empty content list the remote expects.
* The System Logs view filters routine status polls and labels times as UTC. Raw syslog still contains the polls.

## Known limitations

Bluetooth keyboard support in PR #122 is still pending. Windows builds are experimental and unsigned, so SmartScreen can warn on first launch.
