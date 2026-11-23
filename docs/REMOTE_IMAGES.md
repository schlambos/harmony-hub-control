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
3. **Save** the activity. Each screen remote shows the new icon after its
   next sync: picking it up is usually enough. If one doesn't, choose
   **Sync remote** on it.

**Remove icon** clears it (save afterwards). The browser draws and scales the
icon, so the hub only receives a 70x70 PNG and its 38x38 thumbnail.

An icon that shows **Not on the hub** was kept by Logitech. Sync it from
Logitech (below), or choose a new one. If the editor says the hub's software
is older than the editor, update the hub first: setting icons needs it.

The Melodious apps show the same icon in their activity lists, and fall back
to a symbol for the activity's kind when it has none or the hub doesn't hold
it.

## Edit favorite channels

A screen remote lists favorite channels in an activity that has a device for
changing channels. Each favorite has a channel number, a name and a logo;
choosing one sends the number to that device.

1. On **Activities**, open the activity's **⋮** menu and choose **Favorite
   channels** (the running activity's card has a star button for it). An
   activity with no channel changing device has no such entry, as it has no
   favorites on the remote.
2. **Add a favorite**, or choose one to edit its name, channel number and
   logo. The arrows reorder the list; the bin deletes a favorite.
3. **Upload logo…** takes any image your browser can open. It is scaled to
   fit a 108x108 square, nothing is cropped, and transparent parts stay
   transparent. **Remove logo** leaves the favorite without one.
4. **Save to hub**. Each screen remote shows the list after its next sync.

- **The list belongs to the device, not the activity.** Every activity that
  changes channels on the same device shows the same favorites; the page
  names them.
- **Logos are only uploaded.** There are no built-in symbols for channels.
  Logos Logitech's app set up stay as they are until you replace them, and
  can be synced from Logitech (below).
- **A device made on the hub** has no channel list from Logitech, so it
  can't have favorites.
- The channel number may have digits, `.` and `-` (up to 8 characters); a
  device can have 64 favorites.

## Sync user images from Logitech

Activities and favorites set up with Logitech's app point at images in
Logitech's cloud: activity icons and favorite channel logos. Melodious calls
them user images. The hub can't reach Logitech, so the Melodious desktop app
syncs them for it:

1. Update the hub's software to this version (it receives and serves the
   images).
2. In the desktop app, open **Settings**. Under **Logitech account**, the
   **User images** row shows **Missing: N of M**, or **Fully synced**.
3. Choose **Sync user images from Logitech**.
4. Pick up each screen remote. Its next sync fetches the images. A remote
   that doesn't show them needs **Sync remote** once.

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
- **Right after a hub restart** the row can stay on "Checking…" for up to
  two minutes, until the hub has finished starting. Normally it takes under
  a second.
- **Once is enough.** Images stay on the hub. Sync again only after adding
  activities or favorites that use Logitech images.
- The activity editor shows how many user images are missing and points
  here; in a plain browser it points to the desktop app, because only the
  app can reach Logitech.

## Adding a second screen remote

With [two-screen mode](TWO_SCREEN_REMOTES.md) on, a second screen remote
takes the hub's setup, but its images have to come from somewhere. The
first remote may still show icons and logos it cached while Logitech's
cloud was reachable; a newly paired remote has none, and with the cloud
blocked it shows blank tiles.

Remotes never copy anything from each other. Each one fetches the images
from the hub, so once they are on the hub every screen remote gets them:

1. Turn two-screen on and pair the second remote.
2. In the desktop app, **Settings**, then **Sync user images from
   Logitech** (once; skip it when the row already says **Fully synced**).
3. Sync the new remote (pick it up, or **Sync remote**). It shows the same
   activity icons and favorite logos as the first one.

Icons set in the activity editor are on the hub already, so they need no
step 2.

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
    sync again, and fetch the images.
  - `CommitActivityIcon` stores a new 70x70 icon and its 38x38 thumbnail
    under a fresh `<account id>_<uuid>` name. The activity editor puts
    `Activity/<name>.png` in the activity's `ImageKey` with its next save.
- **Telling the remotes.** A screen remote's quick sync, when it wakes,
  fetches the lists but fetches images only when the hub's
  `contentVersion` (in the state digest) moves, as the stock
  `setup.sync?contentchanged` handler does. Storing synced images, and an
  activity save that changes an icon, move it together with
  `configVersion`. Other saves leave it alone, so a remote doesn't fetch
  every image again after each change.
- **Cleaning up.** When an activity is saved with another icon, without
  one, or is removed, the hub deletes the old icon and its thumbnail unless
  another activity still uses it.
- **Favorites.** `Favorites` reads a device's list and `CommitFavorites`
  replaces it:
  - The list is the `dialPositions` of the first service in `CD_<deviceId>`.
    A kept entry is named by its `station` and keeps its other fields; a new
    one gets a fresh `station`.
  - An uploaded logo is stored as `ci_<fresh uuid>.png`, so a remote asks
    for it under a name it has never cached. Logos no favorite of any device
    uses any more are deleted.
  - The station ids are repeated, in order, in the `ContentUser` resource
    (`preferences.<deviceId>.<service>.stations`), as Logitech kept them. A
    hub without that resource gets none.
  - Both resources are written as text: an empty list has to stay a JSON
    array, which the hub's JSON encoder can't promise.
  - A device with no `CD_` resource gets one on the first save, under the
    lineup id the hub's other favorites use, with the device's own profile
    address. One revision follows, with `contentVersion`.
- **The hub never fetches an image from the internet.** Syncing images
  that only existed in Logitech's cloud is done by the desktop app, which
  downloads them and sends them to the hub.

The API is in [API.md](API.md#remote-images-activity-icons-and-favorite-logos)
and [API.md](API.md#favorite-channels).

## Notes

- Every screen remote on the hub reads the same activities and favorites, so
  an image stored once shows on all of them after their next sync.
- The remote only fetches images when it syncs. Waking it is usually
  enough after an icon change or an image sync. With two screen remotes
  woken one after the other, one has been seen to skip that sync; choose
  **Sync remote** on it.
- A remote keeps an image it already has when the hub can't answer for it,
  so an image missing on the hub isn't always visible as a blank tile.
