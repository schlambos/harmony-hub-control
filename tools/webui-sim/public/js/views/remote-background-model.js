/* Remote background (Remotes → a remote with a screen → Background): the
   models behind the card in remotes.js. Pure functions, no DOM.

   The hub keeps the paired screen remote's own settings in its Settings
   resource (GET /api/remote-background answers them as the hub has them).
   BackgroundImage is the picture on the remote's screen and UserImages the
   pictures saved for it (newest first, at most MaxCount). A picture uploaded
   here is a 240x320 PNG plus a 60x80 thumbnail, both made in the browser; the
   hub saves them and the remote fetches them the next time it syncs.

   docs/REMOTE_BACKGROUNDS.md has the whole flow. */

export const SCREEN = { width: 240, height: 320 };
export const THUMBNAIL = { width: 60, height: 80 };

/* A picture's base name in the hub's store: <name>.png and <name>_small.png. */
const NAME = /^([A-Za-z0-9_-]{1,96})\.png$/;

function settingValues(settings, name) {
  const entry = (settings?.Settings ?? []).find((s) => s?.Name === name);
  if (!entry) return null;
  return {
    values: (Array.isArray(entry.Values) ? entry.Values : []).filter((v) => typeof v === "string"),
    defaultValue: typeof entry.DefaultValue === "string" ? entry.DefaultValue : "",
    maxCount: Number.isInteger(entry.MaxCount) && entry.MaxCount > 0 ? entry.MaxCount : 5,
  };
}

/** The remote's background as the card shows it, or null when the hub has
    no settings for a remote with a screen (none has synced with it yet). */
export function readBackground(settings) {
  if (!settings || typeof settings !== "object") return null;
  const background = settingValues(settings, "BackgroundImage");
  const user = settingValues(settings, "UserImages");
  if (!background || !user) return null;
  const current = background.values[0] ?? "";
  return {
    remoteName: typeof settings.RemoteName === "string" ? settings.RemoteName : "",
    current,
    defaultImage: background.defaultValue,
    isDefault: !current || current === background.defaultValue || !user.values.includes(current),
    pictures: user.values,
    maxCount: user.maxCount,
  };
}

/** The base name of a picture saved on the hub ("" for anything else). */
export function pictureBase(fileName) {
  return NAME.exec(String(fileName ?? ""))?.[1] ?? "";
}

/** Where the web app can show a saved picture (or its thumbnail); "" when
    the name isn't one the hub serves. */
export function pictureUrl(fileName, { small = false } = {}) {
  const base = pictureBase(fileName);
  return base ? `/api/remote-background/image?name=${encodeURIComponent(small ? `${base}_small` : base)}` : "";
}

/** The source rectangle that fills the 3:4 screen: the largest 3:4 area of
    the picture divided by zoom (1 = as large as fits, up to 4), moved by pan
    (-1…1 each way, 0 = centred). */
export function cropRect(sourceWidth, sourceHeight, { zoom = 1, panX = 0, panY = 0 } = {}) {
  const w0 = Math.max(1, Number(sourceWidth) || 1);
  const h0 = Math.max(1, Number(sourceHeight) || 1);
  const aspect = SCREEN.width / SCREEN.height;
  const z = Math.min(4, Math.max(1, Number(zoom) || 1));
  let width = w0 / h0 > aspect ? h0 * aspect : w0;
  let height = width / aspect;
  width /= z;
  height /= z;
  const clamp = (v) => Math.min(1, Math.max(-1, Number(v) || 0));
  const x = (w0 - width) / 2 * (1 + clamp(panX));
  const y = (h0 - height) / 2 * (1 + clamp(panY));
  return { x, y, width, height };
}

/** The pan that keeps the same picture under the frame after a drag of
    (dx, dy) screen pixels on a frame drawn displayWidth wide. */
export function dragPan(pan, rect, sourceWidth, sourceHeight, dx, dy, displayWidth) {
  const scale = rect.width / Math.max(1, displayWidth);
  const slackX = (sourceWidth - rect.width) / 2;
  const slackY = (sourceHeight - rect.height) / 2;
  const clamp = (v) => Math.min(1, Math.max(-1, v));
  return {
    panX: slackX > 0 ? clamp(pan.panX - (dx * scale) / slackX) : 0,
    panY: slackY > 0 ? clamp(pan.panY - (dy * scale) / slackY) : 0,
  };
}

/** The body POST /api/remote-background takes for an upload: the two PNGs as
    data URLs (or bare base64). */
export function uploadRequest(imageDataUrl, thumbnailDataUrl) {
  return { action: "upload", image: String(imageDataUrl ?? ""), thumbnail: String(thumbnailDataUrl ?? "") };
}

/** What the card says after a save, from the hub's answer. */
export function savedMessage(reply) {
  if (!reply?.ok) return reply?.error || "The hub didn't save the background.";
  return "Saved on the hub. On the remote, open its settings and choose Sync remote to see it.";
}
