// Favorite channels: the page's pure logic (views/favorites-model.js).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOGO_SIZE,
  channelDeviceId,
  favoriteErrors,
  favoritesFromReply,
  favoritesSaveBody,
  favoritesSignature,
  fitRect,
  fitsOneRequest,
  logoUrl,
  moveFavorite,
  newFavorite,
  sharingActivities,
} from "../public/js/views/favorites-model.js";

const tv = { "Id-": 1, Name: "TV", Roles: [
  { __type: "DisplayActivityRole", "DeviceId-": 10 },
  { __type: "ChannelChangingActivityRole", "DeviceId-": 20 },
] };
const film = { "Id-": 2, Name: "Film", Roles: [{ __type: "DisplayActivityRole", "DeviceId-": 10 }] };
const guest = { "Id-": 3, Name: "Guest TV", Roles: [{ __type: "ChannelChangingActivityRole", "DeviceId-": 20 }] };
const other = { "Id-": 4, Name: "Radio", Roles: [{ __type: "ChannelChangingActivityRole", "DeviceId-": 30 }] };

const reply = { ok: true, etag: "\"e1\"", positions: [
  { number: "2", name: "Kids", station: "s1", image: "aa-01.png", logo: "ci_aa-01", stored: true },
  { number: "3", name: "News", station: "s2" },
] };

describe("favorites model", () => {
  it("finds the device an activity changes channels on", () => {
    assert.equal(channelDeviceId(tv), "20");
    assert.equal(channelDeviceId(film), "");
    assert.equal(channelDeviceId(null), "");
    assert.equal(channelDeviceId({ Roles: [{ __type: "ChannelChangingActivityRole" }] }), "");
  });

  it("names the other activities that show the same list", () => {
    assert.deepEqual(sharingActivities([tv, film, guest, other], "20", 1), ["Guest TV"]);
    assert.deepEqual(sharingActivities([tv, film, guest, other], "20", "3"), ["TV"]);
    assert.deepEqual(sharingActivities([tv, film], "20", 1), []);
    assert.deepEqual(sharingActivities(undefined, "20", 1), []);
  });

  it("reads the hub's list, and an answer without positions as empty", () => {
    const list = favoritesFromReply(reply);
    assert.deepEqual(list.map(({ key, ...rest }) => rest), [
      { number: "2", name: "Kids", station: "s1", image: "aa-01.png", logo: "ci_aa-01", upload: "" },
      { number: "3", name: "News", station: "s2", image: "", logo: "", upload: "" },
    ]);
    assert.notEqual(list[0].key, list[1].key);
    assert.deepEqual(favoritesFromReply({ ok: true, count: 0 }), []);
    assert.deepEqual(favoritesFromReply(null), []);
    assert.equal(logoUrl("ci_aa-01"), "/api/remote-images/image?name=ci_aa-01");
    assert.equal(logoUrl(""), "");
  });

  it("checks a favorite as the hub does", () => {
    assert.deepEqual(favoriteErrors({ number: "12", name: "News" }), {});
    assert.deepEqual(favoriteErrors({ number: " 12-1 ", name: " News " }), {});
    assert.deepEqual(favoriteErrors({ number: "7.2", name: "Č" }), {});
    assert.ok(favoriteErrors({ number: "", name: "News" }).number);
    assert.ok(favoriteErrors({ number: "12a", name: "News" }).number);
    assert.ok(favoriteErrors({ number: "123456789", name: "News" }).number);
    assert.ok(favoriteErrors({ number: "1", name: "   " }).name);
    assert.ok(favoriteErrors({ number: "1", name: "n".repeat(65) }).name);
    assert.ok(favoriteErrors({ number: "1", name: "č".repeat(33) }).name, "the limit is in bytes");
    assert.ok(favoriteErrors({ number: "1", name: "a\tb" }).name);
    assert.deepEqual(Object.keys(favoriteErrors({})).sort(), ["name", "number"]);
  });

  it("moves an entry and leaves the list alone at the ends", () => {
    const list = ["a", "b", "c"];
    assert.deepEqual(moveFavorite(list, 2, -1), ["a", "c", "b"]);
    assert.deepEqual(moveFavorite(list, 0, 1), ["b", "a", "c"]);
    assert.equal(moveFavorite(list, 0, -1), list);
    assert.equal(moveFavorite(list, 2, 1), list);
    assert.equal(moveFavorite(list, -1, 1), list);
    assert.deepEqual(list, ["a", "b", "c"]);
  });

  it("knows when there is something to save", () => {
    const list = favoritesFromReply(reply);
    const saved = favoritesSignature(list);
    assert.equal(favoritesSignature(favoritesFromReply(reply)), saved, "keys don't count");
    assert.equal(favoritesSignature(list.map((f) => ({ ...f, name: ` ${f.name} ` }))), saved, "nor does padding");
    assert.notEqual(favoritesSignature(moveFavorite(list, 0, 1)), saved);
    assert.notEqual(favoritesSignature([{ ...list[0], number: "9" }, list[1]]), saved);
    assert.notEqual(favoritesSignature([{ ...list[0], image: "", logo: "" }, list[1]]), saved);
    assert.notEqual(favoritesSignature([{ ...list[0], upload: "data:image/png;base64,AAAA" }, list[1]]), saved);
    assert.notEqual(favoritesSignature([...list, { ...newFavorite(), number: "1", name: "X" }]), saved);
    assert.notEqual(favoritesSignature([list[0]]), saved);
  });

  it("builds the save: kept entries by station, logos once, by place", () => {
    const [kids, news] = favoritesFromReply(reply);
    const body = favoritesSaveBody({ deviceId: 20, etag: reply.etag, list: [
      { ...news, name: " News One ", upload: "data:image/png;base64,BBBB" },
      kids,
      { ...newFavorite(), number: " 12-1 ", name: "Sport" },
      { ...kids, station: "", key: "x", upload: "data:image/png;base64,CCCC" },
    ] });
    assert.deepEqual(body, {
      deviceId: "20",
      etag: "\"e1\"",
      logos: ["data:image/png;base64,BBBB", "data:image/png;base64,CCCC"],
      positions: [
        { number: "3", name: "News One", station: "s2", logo: 0 },
        { number: "2", name: "Kids", station: "s1", image: "aa-01.png" },
        { number: "12-1", name: "Sport" },
        { number: "2", name: "Kids", logo: 1 },
      ],
    });
    const empty = favoritesSaveBody({ deviceId: "20", etag: "", list: [] });
    assert.deepEqual(empty, { deviceId: "20", positions: [] });
    assert.equal(fitsOneRequest(body), true);
    assert.equal(fitsOneRequest({ ...body, logos: ["x".repeat(1000 * 1000)] }), false);
  });

  it("fits a picture into the logo square without cropping", () => {
    assert.equal(LOGO_SIZE, 108);
    assert.deepEqual(fitRect(200, 80), { x: 0, y: 33, width: 108, height: 43 });
    assert.deepEqual(fitRect(80, 200), { x: 33, y: 0, width: 43, height: 108 });
    assert.deepEqual(fitRect(54, 54), { x: 0, y: 0, width: 108, height: 108 });
    assert.deepEqual(fitRect(1000, 1), { x: 0, y: 54, width: 108, height: 1 });
    assert.deepEqual(fitRect(0, 0), { x: 0, y: 0, width: 108, height: 108 });
    assert.deepEqual(fitRect(100, 50, 50), { x: 0, y: 13, width: 50, height: 25 });
  });
});
