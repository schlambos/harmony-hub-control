// Remote images: the simulator's /api/remote-images and /api/activity-icon
// routes behaving like codex_webui's and codexactivity's.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 19100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

const post = (path, body) => fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const getJson = async (path) => (await fetch(`${BASE}${path}`)).json();

// The header the hub checks: signature, IHDR, width, height.
function png(width, height, tag = 0) {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[39] = tag;
  return `data:image/png;base64,${b.toString("base64")}`;
}

before(async () => {
  proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("simulator didn't start")), 10000);
    proc.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => reject(new Error(`simulator exited (${code})`)));
  });
});

after(() => proc?.kill());
beforeEach(() => post("/api/sim/reset", {}));

describe("simulator remote images", () => {
  it("lists activity icons (with _small) and favorite logos, none stored", async () => {
    const body = await getJson("/api/remote-images");
    assert.equal(body.ok, true);
    const kinds = new Set(body.images.map((p) => p.kind));
    assert.ok(kinds.has("activity") && kinds.has("logo"));
    const icon = body.images.find((p) => p.kind === "activity" && !p.name.endsWith("_small"));
    assert.ok(body.images.some((p) => p.name === `${icon.name}_small`));
    assert.match(icon.uri, new RegExp(`Activity/${icon.name}\\.png$`));
    const logo = body.images.find((p) => p.kind === "logo");
    assert.match(logo.name, /^ci_[A-Za-z0-9-]+$/);
    assert.equal(logo.uri, `content-image://1.0/image/${logo.name.slice(3)}.png`);
    assert.equal(body.missing, body.total);
    assert.equal(body.truncated, false);
  });

  it("stores listed images, refuses unlisted names, and serves what it stored", async () => {
    const { images } = await getJson("/api/remote-images");
    const logo = images.find((p) => p.kind === "logo");
    const res = await post("/api/remote-images", { images: [
      { name: logo.name, image: png(54, 50, 7) },
      { name: "Settings", image: png(54, 50) },
    ] });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.saved, [logo.name]);
    assert.equal(body.failed[0].name, "Settings");
    const after = await getJson("/api/remote-images");
    assert.equal(after.images.find((p) => p.name === logo.name).stored, true);
    assert.equal(after.missing, after.total - 1);
    const image = await fetch(`${BASE}/api/remote-images/image?name=${logo.name}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await image.arrayBuffer())[39], 7);
  });

  it("answers 422 when nothing was saved, 400 for bad images", async () => {
    let res = await post("/api/remote-images", { images: [{ name: "nobody", image: png(54, 50) }] });
    assert.equal(res.status, 422);
    res = await post("/api/remote-images", { images: [{ name: "ci_x", image: png(600, 50) }] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /at most 512x512/);
    res = await post("/api/remote-images", { images: [] });
    assert.equal(res.status, 400);
    res = await post("/api/remote-images", { images: [{ name: "../x", image: png(54, 50) }] });
    assert.equal(res.status, 400);
  });

  it("stores a new 70x70 icon with its 38x38 thumbnail under a fresh ImageKey", async () => {
    let res = await post("/api/activity-icon", { image: png(70, 70), thumbnail: png(38, 38) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.imageKey, `Activity/${body.name}.png`);
    assert.equal((await fetch(`${BASE}/api/remote-images/image?name=${body.name}_small`)).status, 200);
    res = await post("/api/activity-icon", { image: png(64, 64), thumbnail: png(38, 38) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /70x70/);
  });

  it("skips missing images with ?offset, and lets a stored image be cached", async () => {
    const all = await getJson("/api/remote-images");
    const skipped = await getJson("/api/remote-images?offset=2");
    assert.equal(skipped.offset, 2);
    assert.equal(skipped.missing, all.missing);
    assert.equal(skipped.images[0].name, all.images[2].name);
    assert.equal(skipped.images.length, all.images.length - 2);
    assert.equal((await getJson("/api/remote-images?offset=junk")).images.length, all.images.length);
    const logo = all.images.find((p) => p.kind === "logo");
    await post("/api/remote-images", { images: [{ name: logo.name, image: png(54, 50) }] });
    const image = await fetch(`${BASE}/api/remote-images/image?name=${logo.name}`);
    assert.equal(image.headers.get("cache-control"), "private, max-age=86400");
    const missing = await fetch(`${BASE}/api/remote-images/image?name=ci_none`);
    assert.equal(missing.headers.get("cache-control"), "no-store");
  });

  it("answers 404 for an image it doesn't hold", async () => {
    assert.equal((await fetch(`${BASE}/api/remote-images/image?name=ci_none`)).status, 404);
  });
});
