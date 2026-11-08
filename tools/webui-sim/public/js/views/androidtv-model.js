/* Network Android/Google TVs (codex_androidtv): the logic behind the Add a TV flow
   and the device page, without the DOM, so it can be tested in node.

   A network TV is an ordinary hub device that codexactivity's
   CommitAndroidTvDevices writer owns: its AutoDetectedDevice.Id starts with
   "melodious-androidtv-", and its {d} token is the TV's id in codex_androidtv
   ("androidtv" + 8 hex digits). Its commands are a fixed set the writer adds. */

export const ANDROIDTV_TAG = "melodious-androidtv-";

/** The code an Android TV shows when pairing: 6 hexadecimal characters. */
export const CODE_LENGTH = 6;

export function isAndroidTvEntry(entry) {
  return String(entry?.Device?.AutoDetectedDevice?.Id ?? "").startsWith(ANDROIDTV_TAG);
}

export function isAndroidTvDevice(device) {
  return isAndroidTvEntry(device?.entry ?? device);
}

/** The TV's id in codex_androidtv, from the device's {d} token, or "". */
export function androidTvIdOf(entryOrDevice) {
  const entry = entryOrDevice?.entry ?? entryOrDevice;
  const tokens = entry?.Device?.Tokens?.Parameters ?? [];
  const token = tokens.find((t) => t?.Key === "{d}");
  return typeof token?.Value === "string" ? token.Value : "";
}

/**
 * Tidy what someone typed from the TV's screen: spaces and dashes go,
 * letters go upper case. { code } when it is 6 hex characters, otherwise
 * { error } in words for the person typing it.
 */
export function normalizeCode(text) {
  const code = String(text ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (!code) return { error: "Enter the code the TV shows." };
  if (/[^0-9A-F]/.test(code)) return { error: "The code uses only the digits 0–9 and the letters A–F." };
  if (code.length !== CODE_LENGTH) return { error: `The code has ${CODE_LENGTH} characters.` };
  return { code };
}

/** An IPv4 address someone typed, or null. */
export function normalizeHost(text) {
  const host = String(text ?? "").trim();
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
  }
  return parts.map(Number).join(".");
}

/** The network TVs on the hub now, as the writer's device specs. */
export function androidTvSpecs(config) {
  const entries = config?.deviceList?.DevicesWithFeatures ?? [];
  return entries.filter(isAndroidTvEntry).map((entry) => ({
    entity: androidTvIdOf(entry),
    name: String(entry.Device?.Name ?? ""),
    manufacturer: String(entry.Device?.Manufacturer ?? "") || undefined,
    model: String(entry.Device?.Model ?? "") || undefined,
  })).filter((spec) => spec.entity);
}

/**
 * The whole device set for /api/androidtv/devices: what the hub has, plus `add`
 * (replacing a device for the same TV), minus the TV id `remove`. The writer
 * keeps device and command ids across saves, so sending the full set again
 * changes only what differs.
 */
export function androidTvDeviceSet(config, { add = null, remove = "" } = {}) {
  let devices = androidTvSpecs(config);
  if (remove) devices = devices.filter((d) => d.entity !== remove);
  if (add) {
    devices = devices.filter((d) => d.entity !== add.entity);
    devices.push({
      entity: add.entity,
      name: String(add.name ?? "").trim(),
      ...(add.manufacturer ? { manufacturer: String(add.manufacturer).trim() } : {}),
      ...(add.model ? { model: String(add.model).trim() } : {}),
    });
  }
  return { devices };
}

/** A hub device name: 1–64 characters, no quotes or backslashes. */
export function nameProblem(name) {
  const text = String(name ?? "").trim();
  if (!text) return "Give the TV a name.";
  if (text.length > 64) return "The name can have up to 64 characters.";
  if (/["\\]/.test(text)) return "The name can't contain quotes or backslashes.";
  return "";
}

/** One line about a TV's connection, for its device page. */
export function tvStatusText(tv) {
  if (!tv) return "Not paired with the hub's network TV service.";
  if (tv.connected) {
    const power = tv.on ? "On" : "In standby";
    const volume = Number(tv.volume) >= 0 && Number(tv.volumeMax) > 0 ? ` · Volume ${tv.volume}` : "";
    return `Connected · ${power}${volume} · ${tv.host}`;
  }
  const why = tv.error ? ` (${tv.error})` : "";
  return `Not connected${why} · ${tv.host}. It turns on by network when it is in standby.`;
}

/**
 * Found TVs for the list, those already on the hub marked, in a stable
 * order. `paired` holds codex_androidtv ids of TVs that have a hub device.
 */
export function foundList(found, devicesByTv) {
  return [...(found ?? [])]
    .filter((f) => f?.host)
    .map((f) => ({
      name: String(f.name || f.host),
      host: String(f.host),
      added: Boolean(f.paired && devicesByTv?.has?.(f.paired)),
    }))
    .sort((a, b) => Number(a.added) - Number(b.added) || a.name.localeCompare(b.name));
}

/**
 * The pairing to undo when the Add a TV sheet closes, or "". Only a pairing
 * no hub device uses: not one whose device was saved (`committed`), and not
 * one for a TV that already has a device (paired again from a typed address).
 */
export function pairingToUndo(tvId, { committed = false, devicesByTv = new Set() } = {}) {
  const id = String(tvId ?? "");
  if (!id || committed || devicesByTv?.has?.(id)) return "";
  return id;
}

/** What the wait step says for codex_androidtv's pairing state. */
export function pairStateText(state, name) {
  switch (state) {
    case "preparing":
      return "Getting the hub ready. The first time takes up to half a minute…";
    case "connecting":
      return `Asking ${name || "the TV"} to show a code…`;
    case "checking":
      return "Checking the code…";
    default:
      return "";
  }
}
