# Issue #86 snapshots

A reporter's hub, as attached to issue #86 (RFIDs, `AccountId-` and Bluetooth
addresses masked by the reporter). Logitech set the hub up with a Companion
(16422); a Smart Control (16414) was paired later through Melodious.

- `importhub_backup_002052_*`: after pairing the Smart Control and setting its
  activity buttons. `16414Root` exists; no `16414Activity<id>` map does.
- `importhub_backup_002323_MapList.json`: after SHIELD TV and Listen to Music
  were each opened and saved again, which made their `16414Activity<id>` maps
  (and SHIELD TV's `16420Activity<id>` keyboard map).

Used by `test/issue86-paired-remote-maps.test.mjs`.
