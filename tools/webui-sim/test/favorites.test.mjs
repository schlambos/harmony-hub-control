// Favorite channels: the simulator's /api/favorites routes behaving like
// codex_webui's and codexactivity's (Favorites, CommitFavorites).
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 19200 + Math.floor(Math.random() * 90);
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

const TV = "74521691"; // the fixture's LG TV: the sim's two made-up favorites
const list = (id = TV) => getJson(`/api/favorites?deviceId=${id}`);

describe("simulator favorites", () => {
  it("lists a device's favorites with their logo names", async () => {
    const r = await list();
    assert.equal(r.ok, true);
    assert.equal(r.exists, true);
    assert.equal(r.count, 2);
    assert.equal(r.max, 64);
    assert.deepEqual(r.positions.map((p) => [p.number, p.name, p.stored]), [["2", "Kids Channel", false], ["5", "News 24", false]]);
    assert.match(r.positions[0].logo, /^ci_[0-9a-f-]+$/);
    assert.equal(r.positions[0].image, `${r.positions[0].logo.slice(3)}.png`);
    assert.equal(typeof r.etag, "string");
    assert.ok((await getJson("/api/version")).features.includes("favorites"));
  });

  it("tells whether a device without favorites can get some", async () => {
    const amp = await list("81897247");
    assert.deepEqual([amp.exists, amp.canCreate, amp.count, amp.positions], [false, true, 0, undefined]);
    const madeHere = await list("93111391");
    assert.equal(madeHere.canCreate, false);
    assert.match(madeHere.reason, /made on the hub/);
    assert.equal((await list("1")).canCreate, false);
    assert.equal((await fetch(`${BASE}/api/favorites?deviceId=5x`)).status, 400);
    assert.equal((await fetch(`${BASE}/api/favorites`)).status, 400);
  });

  it("replaces the list: reorder, rename, add, upload a logo, remove one", async () => {
    const before = await list();
    const [kids, news] = before.positions;
    const res = await post("/api/favorites", {
      deviceId: TV,
      etag: before.etag,
      logos: [png(108, 108, 7)],
      positions: [
        { number: "50", name: " News One ", station: news.station, logo: 0 },
        { number: "2", name: "Kids Channel", station: kids.station },
        { number: "12-1", name: "Sport" },
      ],
    });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.count, 3);
    assert.deepEqual(r.positions.map((p) => [p.number, p.name]), [["50", "News One"], ["2", "Kids Channel"], ["12-1", "Sport"]]);
    assert.equal(r.positions[0].station, news.station);
    assert.notEqual(r.positions[0].image, news.image, "an uploaded logo gets a fresh name");
    assert.equal(r.positions[0].stored, true);
    assert.equal(r.positions[1].logo, undefined, "a logo left out is removed");
    assert.ok(r.positions[2].station && r.positions[2].logo === undefined);
    assert.notEqual(r.etag, before.etag);
    assert.deepEqual(await list(), r);
    const logo = await fetch(`${BASE}/api/remote-images/image?name=${r.positions[0].logo}`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/png");
    // The image list follows: only the new logo is asked for, and it is stored.
    const images = (await getJson("/api/remote-images")).images.filter((i) => i.kind === "logo");
    assert.deepEqual(images.map((i) => [i.name, i.stored, i.deviceId]), [[r.positions[0].logo, true, TV]]);
  });

  it("keeps a logo by naming its image, and deletes a stored one nobody uses", async () => {
    const before = await list();
    const [kids, news] = before.positions;
    await post("/api/remote-images", { images: [{ name: kids.logo, image: png(54, 50) }, { name: news.logo, image: png(54, 50) }] });
    const r = await (await post("/api/favorites", {
      deviceId: TV,
      positions: [{ number: "2", name: "Kids Channel", station: kids.station, image: kids.image }],
    })).json();
    assert.deepEqual([r.count, r.positions[0].image, r.positions[0].stored], [1, kids.image, true]);
    assert.equal((await fetch(`${BASE}/api/remote-images/image?name=${news.logo}`)).status, 404);
  });

  it("saves an empty list and leaves positions out of the answer", async () => {
    const r = await (await post("/api/favorites", { deviceId: TV, positions: [] })).json();
    assert.deepEqual([r.ok, r.count, r.positions], [true, 0, undefined]);
  });

  it("starts favorites for a device that had none, but not for one made on the hub", async () => {
    const r = await (await post("/api/favorites", { deviceId: "81897247", positions: [{ number: "1", name: "One" }] })).json();
    assert.deepEqual([r.ok, r.exists, r.count], [true, true, 1]);
    const refused = await post("/api/favorites", { deviceId: "93111391", positions: [{ number: "1", name: "One" }] });
    assert.equal(refused.status, 422);
    assert.match((await refused.json()).error, /made on the hub/);
  });

  it("answers 400 for a malformed request and 422 for one the hub refuses", async () => {
    const before = await list();
    const bad = async (body, status, pattern) => {
      const res = await post("/api/favorites", body);
      assert.equal(res.status, status, JSON.stringify(body).slice(0, 80));
      const json = await res.json();
      assert.equal(json.ok, false);
      if (pattern) assert.match(json.error, pattern);
    };
    await bad({ deviceId: 74521691, positions: [] }, 400, /deviceId/);
    await bad({ deviceId: TV }, 400, /positions/);
    await bad({ deviceId: TV, positions: [], logos: ["R0lGODlh"] }, 400);
    await bad({ deviceId: TV, positions: [], logos: [png(600, 54)] }, 400, /512x512/);
    await bad({ deviceId: TV, etag: "\"old\"", positions: [] }, 422, /changed on the hub/);
    await bad({ deviceId: TV, positions: [{ number: "12a", name: "X" }] }, 422, /channel number/);
    await bad({ deviceId: TV, positions: [{ number: "123456789", name: "X" }] }, 422, /channel number/);
    await bad({ deviceId: TV, positions: [{ number: "1", name: "  " }] }, 422, /name/);
    await bad({ deviceId: TV, positions: [{ number: "1", name: "n".repeat(65) }] }, 422, /name/);
    await bad({ deviceId: TV, positions: [{ number: "1", name: "X", station: "nope" }] }, 422, /favorites/);
    await bad({ deviceId: TV, positions: [{ number: "1", name: "X", image: "eeee.png" }] }, 422, /logo/);
    await bad({ deviceId: TV, positions: [{ number: "1", name: "X", logo: 0 }] }, 422, /logo/);
    await bad({ deviceId: TV, positions: Array.from({ length: 65 }, (_, i) => ({ number: String(i), name: "C" })) }, 422, /at most 64/);
    assert.deepEqual(await list(), before, "nothing changed");
  });

  it("refuses a cross-site POST", async () => {
    const res = await fetch(`${BASE}/api/favorites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ deviceId: TV, positions: [] }),
    });
    assert.equal(res.status, 403);
  });
});
