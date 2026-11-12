# Issue #86 synthetic fixture

Synthetic hub snapshots for `test/issue86-paired-remote-maps.test.mjs`.
Generic activities (101/Alpha, 102/Beta, 103/Gamma), devices (9001/9002)
and surface ids (7000001/6000001) in the same shape as the reported hub,
with no reporter device/activity names, ids, RFIDs or account data.

- `synthetic_ActivityList.json`: three activities (Beta has a
  keyboard text-entry role, like one activity on the reported hub).
- `synthetic_paired_MapList.json`: after pairing the second remote.
  `16422` has its `Activity` maps; `16414` has only a `Root` (null
  surface ids, missing one activity button) and no `Activity` maps —
  the reported bug state.
- `synthetic_resaved_MapList.json`: after Beta and Gamma were each
  opened and saved again, which made their `16414` maps (plus Beta's
  `16420` keyboard map, which no remote resolves through). Alpha was
  never re-saved, so it still has no `16414` map — the fix must
  create it too.

What the test proves against these files:

- the fix turns the paired snapshot into the resaved snapshot's `16414`
  maps with no re-save, key-for-key and command-for-command;
- only `ButtonCommandAction` presses are copied (Beta's `Red`
  `ButtonSequenceAction` stays its own map's; Gamma's soft button is skipped;
  the `16420` keyboard map is never a source or a target);
- `UpArrow`/`DownArrow` (keys the editor doesn't list) are still copied;
- long-press commands ride along; number keys keep `FunctionGroupType 2`;
- with no source keys an empty map is still made (so Off reaches Root);
- screen remotes (16417), keyboards (16420) and dongles (34830) are left alone.
