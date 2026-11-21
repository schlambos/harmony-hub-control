/* Favorite channels, the part with no DOM: what the hub's list becomes on
   the page, what an edited list becomes for the hub, and the checks the hub
   makes too (so a mistake shows before Save). docs/REMOTE_IMAGES.md */

/** Side of the square an uploaded logo is drawn into, in pixels. The remote
    asks for at most 54x54; twice that keeps it sharp in the web and apps. */
export const LOGO_SIZE = 108;

export const NAME_MAX_BYTES = 64;
export const NUMBER_MAX = 8;

/** A whole save may be 1 MB; leave room for the list itself. */
export const REQUEST_MAX_BYTES = 1000 * 1000;

/** The device an activity changes channels on, or "" when it has none: the
    remote lists that device's favorites in the activity. */
export function channelDeviceId(activity) {
  const role = (activity?.Roles ?? []).find((r) =>
    r?.__type === "ChannelChangingActivityRole" && r["DeviceId-"] != null);
  return role ? String(role["DeviceId-"]) : "";
}

/** Names of the other activities that list the same device's favorites. */
export function sharingActivities(activities, deviceId, activityId) {
  return (activities ?? [])
    .filter((a) => String(a?.["Id-"]) !== String(activityId) && channelDeviceId(a) === String(deviceId))
    .map((a) => String(a.Name ?? ""))
    .filter(Boolean);
}

/** Where the hub serves a stored logo ("ci_<uuid>"), or "". */
export function logoUrl(logo) {
  return logo ? `/api/remote-images/image?name=${encodeURIComponent(logo)}` : "";
}

let nextKey = 1;

/** A new favorite, not on the hub yet. */
export function newFavorite() {
  return { key: `n${nextKey++}`, number: "", name: "", station: "", image: "", logo: "", upload: "" };
}

/** The hub's answer as the page's list. Each entry: key (for the page only),
    number, name, station ("" for a new one), image and logo (the stored
    logo's file and name, "" for none), upload (a PNG data URL chosen here
    and not saved yet, "" for none). */
export function favoritesFromReply(reply) {
  return (Array.isArray(reply?.positions) ? reply.positions : []).map((p) => ({
    key: `s${nextKey++}`,
    number: String(p?.number ?? ""),
    name: String(p?.name ?? ""),
    station: String(p?.station ?? ""),
    image: p?.logo ? String(p.image ?? "") : "",
    logo: String(p?.logo ?? ""),
    upload: "",
  }));
}

const byteLength = (text) => new TextEncoder().encode(text).length;

/** Why a favorite can't be saved, by field, in the hub's own terms; an
    empty object when it can. */
export function favoriteErrors({ number, name }) {
  const errors = {};
  const n = String(number ?? "").trim();
  if (!n) errors.number = "Enter the channel number.";
  else if (!/^[0-9.-]+$/.test(n)) errors.number = "Only digits, “.” and “-”.";
  else if (n.length > NUMBER_MAX) errors.number = `At most ${NUMBER_MAX} characters.`;
  const text = String(name ?? "").trim();
  if (!text) errors.name = "Enter a name.";
  else if (byteLength(text) > NAME_MAX_BYTES) errors.name = "That name is too long.";
  // eslint-disable-next-line no-control-regex
  else if (/[\x00-\x1f\x7f]/.test(text)) errors.name = "Use plain text only.";
  return errors;
}

/** The list with the entry at `index` moved by `step` (-1 up, 1 down). */
export function moveFavorite(list, index, step) {
  const to = index + step;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** What only the hub's part of an entry looks like; two lists that match
    here have nothing to save. */
export function favoritesSignature(list) {
  return JSON.stringify(list.map((f) => [f.station, f.number.trim(), f.name.trim(), f.upload ? `new:${f.upload.length}:${f.upload.slice(-24)}` : f.image]));
}

/** The POST /api/favorites body for an edited list. Uploaded logos travel
    once in `logos`; an entry names its own by place. */
export function favoritesSaveBody({ deviceId, etag, list }) {
  const logos = [];
  const positions = list.map((f) => {
    const position = { number: f.number.trim(), name: f.name.trim() };
    if (f.station) position.station = f.station;
    if (f.upload) {
      position.logo = logos.length;
      logos.push(f.upload);
    } else if (f.image) {
      position.image = f.image;
    }
    return position;
  });
  const body = { deviceId: String(deviceId), positions };
  if (etag) body.etag = etag;
  if (logos.length) body.logos = logos;
  return body;
}

/** True when the body fits one request to the hub. */
export function fitsOneRequest(body) {
  return byteLength(JSON.stringify(body)) <= REQUEST_MAX_BYTES;
}

/** Where a w x h picture goes in a size x size square: as large as fits,
    centred, nothing cropped (the rest stays transparent). */
export function fitRect(width, height, size = LOGO_SIZE) {
  if (!(width > 0) || !(height > 0)) return { x: 0, y: 0, width: size, height: size };
  const scale = Math.min(size / width, size / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { x: Math.round((size - w) / 2), y: Math.round((size - h) / 2), width: w, height: h };
}
