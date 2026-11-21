// Sync user images from Logitech (connect/images.js), against a fake hub:
// status, batches, per-image retry when the hub refuses a batch, getting
// past images Logitech no longer has, and an older hub without the route.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/connect/images.js", import.meta.url), "utf8");

function load() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "images.js" });
  return context.melodiousImageSync;
}

// A hub listing `names` as missing; `bad` names fail staging (400 for a
// whole batch), `gone` ones Logitech no longer has.
function fakeHub({ names, bad = [], gone = [], listMax = 100, oldHub = false }) {
  const stored = new Set();
  const posts = [];
  const gets = [];
  const reply = (status, body) => ({ ok: status === 200, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const fetchImpl = async (path, options = {}) => {
    if (oldHub) return reply(404, "Not found\n");
    if (options.method === "POST") {
      const { images } = JSON.parse(options.body);
      posts.push(images.map((i) => i.name));
      if (images.some((i) => bad.includes(i.name))) return reply(400, { ok: false, error: "The image must be at most 512x512 pixels." });
      images.forEach((i) => stored.add(i.name));
      return reply(200, { ok: true, saved: images.map((i) => i.name), failed: [] });
    }
    gets.push(path);
    const offset = Number(new URL(path, "http://hub").searchParams.get("offset") || 0);
    const missing = names.filter((n) => !stored.has(n));
    const listed = missing.slice(offset).slice(0, listMax).map((name) => ({ name, stored: false, uri: `content-image://1.0/image/${name}.png` }));
    return reply(200, { ok: true, images: listed, missing: missing.length, total: names.length, contentImageHost: "https://logos.example.invalid" });
  };
  const remoteImage = async ({ uri }) => {
    const name = /image\/(.+)\.png$/.exec(uri)[1];
    if (gone.includes(name)) throw new Error("Logitech no longer has this image");
    return { image: `data:image/png;base64,${name}` };
  };
  return { fetchImpl, remoteImage, stored, posts, gets };
}

test("status: counts, and an older hub without the route", async () => {
  const { createImageSync } = load();
  const hub = fakeHub({ names: ["a", "b"] });
  assert.deepEqual({ ...(await createImageSync(hub).status()) }, { state: "ready", missing: 2, total: 2 });
  const old = fakeHub({ names: [], oldHub: true });
  assert.equal((await createImageSync(old).status()).state, "old-hub");
});

test("sync stores every missing image and reports progress", async () => {
  const { createImageSync } = load();
  const hub = fakeHub({ names: ["a", "b", "c"] });
  const progress = [];
  const sync = createImageSync(hub);
  const result = await sync.sync((p) => progress.push(p.done));
  assert.equal(result.synced, 3);
  assert.equal(result.failed.size, 0);
  assert.deepEqual([...hub.stored].sort(), ["a", "b", "c"]);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.match(sync.summary(result), /^Synced 3 images to the hub\. Choose Sync remote on each screen remote/);
});

test("a batch the hub refuses is sent again one image at a time", async () => {
  const { createImageSync } = load();
  const hub = fakeHub({ names: ["a", "bad", "b"], bad: ["bad"] });
  const result = await createImageSync(hub).sync();
  assert.equal(result.synced, 2);
  assert.deepEqual([...result.failed.keys()], ["bad"]);
  assert.match(result.failed.get("bad"), /512x512/);
  assert.deepEqual(hub.posts, [["a", "bad", "b"], ["a"], ["bad"], ["b"]]);
});

test("a full page of images Logitech no longer has doesn't block the rest", async () => {
  const { createImageSync } = load();
  const names = ["g1", "g2", "g3", "ok1", "ok2"];
  const hub = fakeHub({ names, gone: ["g1", "g2", "g3"], listMax: 3 });
  const sync = createImageSync(hub);
  const result = await sync.sync();
  assert.equal(result.synced, 2);
  assert.deepEqual([...result.failed.keys()], ["g1", "g2", "g3"]);
  assert.deepEqual([...hub.stored].sort(), ["ok1", "ok2"]);
  assert.ok(hub.gets.some((p) => p.endsWith("offset=3")), hub.gets.join(" "));
  assert.match(sync.summary(result), /3 could not be synced \(Logitech no longer has this image\)/);
});

test("nothing missing: one look at the hub, nothing sent", async () => {
  const { createImageSync } = load();
  const hub = fakeHub({ names: [] });
  const result = await createImageSync(hub).sync();
  assert.equal(result.synced, 0);
  assert.equal(hub.posts.length, 0);
  assert.equal(hub.gets.length, 1);
});
