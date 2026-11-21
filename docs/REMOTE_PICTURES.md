# Remote pictures: activity icons and favorite logos

A Harmony remote with a screen shows an icon next to each activity and a logo
next to each favorite channel. Logitech kept these pictures in its cloud, and
the remote fetched them through the hub. With the cloud blocked, those
fetches go nowhere and the remote shows blank tiles. Melodious keeps the
pictures on the hub instead, the same way it keeps
[remote backgrounds](REMOTE_BACKGROUNDS.md).

## Change an activity's icon

1. **Activities → Advanced editor**, then pick the activity.
2. Under **Icon on the remote**, either:
   - choose a symbol and a tile color, then **Use this symbol**; or
   - **Upload picture…** and pick any picture your browser can open. The
     middle square of it is used.
3. **Save** the activity, then choose **Sync remote** on the remote.

**Remove icon** clears it (save afterwards). The browser draws and scales the
icon, so the hub only receives a 70x70 PNG and its 38x38 thumbnail.

An icon that shows **Not on the hub** was kept by Logitech. Recover it with
the desktop app, or choose a new one.

The Melodious apps show the same icon in their activity lists, and fall back
to a symbol for the activity's kind when it has none or the hub doesn't hold
it.

## Recover the original pictures

Activities and favorites set up with Logitech's app point at pictures in
Logitech's cloud, which the hub can't reach. The Melodious desktop app can
fetch them and store them on the hub:

1. In the desktop app, open **Activities → Advanced editor** and pick any
   activity.
2. Below **Icon on the remote**, the editor says how many pictures for the
   remote aren't on the hub. Choose **Recover from Logitech**.
3. Choose **Sync remote** on each screen remote.

- **What is fetched.** The app takes the list from the hub (every
  activity icon with its thumbnail, and every favorite's logo, for every
  device), downloads each picture from Logitech and stores it on the hub
  under the name the remote already asks for. Nothing in the activities or
  favorites changes.
- **What isn't.** The app only fetches Logitech activity icons
  (`https://*.myharmony.com/Activity/<name>.png`) and channel logos (from
  the logo address in the hub's discovery data). It needs no Logitech
  sign-in.
- **Pictures that are gone.** A picture Logitech no longer has is
  reported and skipped; the rest are still stored. Give such an activity a
  new icon in the editor.
- In a plain browser the editor shows the count and points to the desktop
  app, because only the app can reach Logitech.

## How it works

- **What the remote asks for.**
  - Activity icons: `<BaseImageUri>Activity/<name>.png` and
    `<name>_small.png`, where `Activity/<name>.png` is the activity's
    `ImageKey`.
  - Favorite logos: `content-image://1.0/image/<uuid>.png;maxX=..;maxY=..`,
    where `<uuid>.png` is the `image` of a `dialPositions` entry in the
    favorites resource of the device (`CD_<deviceId>`).
- **Where the hub keeps them.** In its resource store, the same place as
  remote backgrounds:
  - an activity icon as `<name>.png` and `<name>_small.png`;
  - a logo as `ci_<uuid>.png`. One logo answers every size the remote asks
    for.
- **Answering the remote.** `netservicestarter.lua` answers these fetches
  with the stored picture, the way the stock image handler does (the PNG as
  the reply's binary payload). A picture the hub doesn't hold stays blocked,
  as before.
- **Which pictures are needed.** The hub works the list out from its own
  data: every activity's `ImageKey` and every favorite in a `CD_*` resource.
  No remote has to sync first, and a remote added later gets the same
  pictures.
- **Storing pictures.** `codexactivity` stores them:
  - `CommitRemotePictures` takes pictures for names on that list only, as
    PNGs up to 512x512 and 512 KB, then publishes one revision so the remotes
    sync again.
  - `CommitActivityIcon` stores a new 70x70 icon and its 38x38 thumbnail
    under a fresh `<account id>_<uuid>` name. The activity editor puts
    `Activity/<name>.png` in the activity's `ImageKey` with its next save.
- **Cleaning up.** When an activity is saved with another icon, without
  one, or is removed, the hub deletes the old icon and its thumbnail unless
  another activity still uses it.
- **The hub never fetches a picture from the internet.** Recovering pictures
  that only existed in Logitech's cloud is done by the desktop app, which
  downloads them and sends them to the hub.

The API is in [API.md](API.md#remote-pictures-activity-icons-and-favorite-logos).

## Notes

- Every screen remote on the hub reads the same activities and favorites, so
  a picture stored once shows on all of them after their next sync.
- The remote only fetches pictures when it syncs. Choose **Sync remote** on
  the remote, or wake it after a change.
- Editing favorites (adding, removing or reordering channels) is not part of
  this; only their logos are.
