"use strict";

// Recover the pictures a screen remote shows (activity icons and favorite
// channel logos) from where Logitech kept them, so the web UI can store them
// on the hub (docs/REMOTE_PICTURES.md). The hub never fetches them itself:
// its cloud access is blocked.
//
// The page passes the address the hub listed for a picture. Only two shapes
// are fetched, so the page can't make the desktop fetch anything else:
// - an activity icon: https://<host>.myharmony.com/Activity/<name>.png
// - a channel logo: content-image://<version>/image/<id>.png, mapped onto the
//   logo host from the hub's discovery data (a cloudfront.net or
//   myharmony.com host), or Logitech's known one when the hub has none.
// No sign-in is needed: Logitech served these as plain files.

const { CatalogError } = require("./oauth");

const PICTURE_MAX_BYTES = 512 * 1024;
const PICTURE_TIMEOUT_MS = 15000;
const LOGO_SIZE_HINT = ";maxX=54;maxY=54";
const DEFAULT_LOGO_HOST = "https://d1tk8oqnnsddt5.cloudfront.net";
const ACTIVITY_PICTURE = /^https:\/\/(?:[a-z0-9-]+\.)+myharmony\.com\/Activity\/[A-Za-z0-9_-]{1,96}\.png$/i;
const CONTENT_PICTURE = /^content-image:\/\/([0-9]{1,3}(?:\.[0-9]{1,3}){0,2})\/image\/([A-Za-z0-9-]{1,64})\.png$/;
const LOGO_HOST = /^https:\/\/(?:[a-z0-9-]+\.)+(?:cloudfront\.net|myharmony\.com)$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The https address to fetch for a picture the hub listed, or null. */
function pictureSourceUrl(uri, contentImageHost) {
  if (typeof uri !== "string" || uri.length > 300) return null;
  if (ACTIVITY_PICTURE.test(uri)) return uri;
  const logo = CONTENT_PICTURE.exec(uri);
  if (!logo) return null;
  const host = typeof contentImageHost === "string" && LOGO_HOST.test(contentImageHost)
    ? contentImageHost
    : DEFAULT_LOGO_HOST;
  return `${host}/${logo[1]}/image/${logo[2]}.png${LOGO_SIZE_HINT}`;
}

/** The body as a Buffer, stopping as soon as it passes PICTURE_MAX_BYTES. */
async function readCapped(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const whole = Buffer.from(await response.arrayBuffer());
    if (whole.length > PICTURE_MAX_BYTES) throw new CatalogError("The picture is larger than 512 KB");
    return whole;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > PICTURE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CatalogError("The picture is larger than 512 KB");
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/** The PNG at url as a Buffer; a CatalogError with a plain message otherwise. */
async function fetchPicture(url, { fetchImpl = globalThis.fetch, timeoutMs = PICTURE_TIMEOUT_MS } = {}) {
  const host = new URL(url).hostname;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "image/png" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new CatalogError(`Could not reach ${host}; try again`);
  }
  if (response.status === 404 || response.status === 403) {
    throw new CatalogError("Logitech no longer has this picture");
  }
  if (response.status !== 200) {
    throw new CatalogError(`${host} answered ${response.status}`);
  }
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > PICTURE_MAX_BYTES) {
    throw new CatalogError("The picture is larger than 512 KB");
  }
  const bytes = await readCapped(response);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    throw new CatalogError("The answer isn't a PNG picture");
  }
  return bytes;
}

function validatePictureArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Invalid picture arguments");
  }
  if (Object.keys(args).some((k) => !["uri", "contentImageHost"].includes(k))) {
    throw new Error("Invalid picture arguments");
  }
  if (args.contentImageHost !== undefined && args.contentImageHost !== null &&
      (typeof args.contentImageHost !== "string" || args.contentImageHost.length > 100)) {
    throw new Error("Invalid picture arguments");
  }
  const url = pictureSourceUrl(args.uri, args.contentImageHost);
  if (!url) throw new Error("Invalid picture address");
  return url;
}

function createPictureFetcher({ fetchImpl = globalThis.fetch } = {}) {
  return {
    /** {uri, contentImageHost?} -> {image: "data:image/png;base64,..."} */
    async fetch(args) {
      const url = validatePictureArgs(args);
      const bytes = await fetchPicture(url, { fetchImpl });
      return { image: `data:image/png;base64,${bytes.toString("base64")}` };
    },
  };
}

module.exports = {
  PICTURE_MAX_BYTES,
  DEFAULT_LOGO_HOST,
  pictureSourceUrl,
  fetchPicture,
  validatePictureArgs,
  createPictureFetcher,
};
