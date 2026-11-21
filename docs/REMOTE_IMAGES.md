# Remote images: activity icons and favorite logos

A Harmony remote with a screen shows an icon next to each activity and a logo
next to each favorite channel. Logitech kept these images in its cloud, and
the remote fetched them through the hub. With the cloud blocked, those
fetches go nowhere and the remote shows blank tiles. Melodious keeps the
images on the hub instead, the same way it keeps
[remote backgrounds](REMOTE_BACKGROUNDS.md).

## Change an activity's icon

1. **Activities → Advanced editor**, then pick the activity.
2. Under **Icon on the remote**, either:
   - choose a symbol and a tile color, then **Use this symbol**; or
   - **Upload image…** and pick any image your browser can open. The
     middle square of it is used.
3. **Save** the activity, then choose **Sync remote** on the remote.

**Remove icon** clears it (save afterwards). The browser draws and scales the
icon, so the hub only receives a 70x70 PNG and its 38x38 thumbnail.

An icon that shows **Not on the hub** was kept by Logitech. Sync it from
Logitech (below), or choose a new one. If the editor says the hub's software
is older than the editor, update the hub first: setting icons needs it.

The Melodious apps show the same icon in their activity lists, and fall back
to a symbol for the activity's kind when it has none or the hub doesn't hold
it.

## Sync user images from Logitech

Activities and favorites set up with Logitech's app point at images in
Logitech's cloud: activity icons and favorite channel logos. Melodious calls
them user images. The hub can't reach Logitech, so the Melodious desktop app
syncs them for it:

1. Update the hub's software to this version (it receives and serves the
   images).
2. In the desktop app, open **Settings**. Under **Logitech account**, the
   **User images** row says how many of the hub's images are missing.
3. Choose **Sync user images from Logitech**.
4. Choose **Sync remote** on each screen remote.

- **The hub stays offline.** The desktop app downloads each image from
  Logitech and sends it to the hub over your network. The hub needs no
  internet access.
- **No Logitech sign-in.** Logitech serves these images as plain files.
- **What is synced.** The list comes from the hub: every activity icon
  with its thumbnail, and every favorite's logo, for every device. Each
  image is stored under the name the remote already asks for. Nothing in
  the activities or favorites changes.
- **What isn't.** The app only downloads Logitech activity icons
  (`https://*.myharmony.com/Activity/<name>.png`) and channel logos (from
  the logo address in the hub's discovery data).
- **Images that are gone.** An image Logitech no longer has is reported
  and skipped; the rest are still synced. Give such an activity a new icon
  in the editor.
- **Once is enough.** Images stay on the hub. Sync again only after adding
  activities or favorites that use Logitech images.
- The activity editor shows how many user images are missing and points
  here; in a plain browser it points to the desktop app, because only the
  app can reach Logitech.

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
  with the stored image, the way the stock image handler does (the PNG as
  the reply's binary payload). An image the hub doesn't hold stays blocked,
  as before.
- **Which images are needed.** The hub works the list out from its own
  data: every activity's `ImageKey` and every favorite in a `CD_*` resource.
  No remote has to sync first, and a remote added later gets the same
  images.
- **Storing images.** `codexactivity` stores them:
  - `CommitRemoteImages` takes images for names on that list only, as
    PNGs up to 512x512 and 512 KB, then publishes one revision so the remotes
    sync again.
  - `CommitActivityIcon` stores a new 70x70 icon and its 38x38 thumbnail
    under a fresh `<account id>_<uuid>` name. The activity editor puts
    `Activity/<name>.png` in the activity's `ImageKey` with its next save.
- **Cleaning up.** When an activity is saved with another icon, without
  one, or is removed, the hub deletes the old icon and its thumbnail unless
  another activity still uses it.
- **The hub never fetches an image from the internet.** Syncing images
  that only existed in Logitech's cloud is done by the desktop app, which
  downloads them and sends them to the hub.

The API is in [API.md](API.md#remote-images-activity-icons-and-favorite-logos).

## Notes

- Every screen remote on the hub reads the same activities and favorites, so
  an image stored once shows on all of them after their next sync.
- The remote only fetches images when it syncs. Choose **Sync remote** on
  the remote, or wake it after a change.
- Editing favorites (adding, removing or reordering channels) is not part of
  this; only their logos are.
