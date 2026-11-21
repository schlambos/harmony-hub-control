// Remote backgrounds: remote-background-model.js, and the simulator's
// /api/remote-background routes behaving like codex_webui's and codexactivity's.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SCREEN,
  THUMBNAIL,
  cropRect,
  dragPan,
  pictureBase,
  pictureUrl,
  readBackground,
  savedMessage,
  uploadRequest,
} from "../public/js/views/remote-background-model.js";

const DEFAULT = "00000000-0000-4000-8000-0000000000d1.png";
const settings = (pictures = [], current = [DEFAULT]) => ({
  RemoteName: "Harmony Elite",
  Settings: [
    { Name: "UserImages", MaxCount: 5, DefaultValue: null, Values: pictures },
    { Name: "BackgroundImage", MaxCount: 1, DefaultValue: DEFAULT, Values: current },
    { Name: "ScreenBrightness", Values: ["85"] },
  ],
});

describe("remote background model", () => {
  it("reads the background and the saved pictures", () => {
    const bg = readBackground(settings(["a.png", "b.png"], ["b.png"]));
    assert.equal(bg.remoteName, "Harmony Elite");
    assert.equal(bg.current, "b.png");
    assert.equal(bg.isDefault, false);
    assert.deepEqual(bg.pictures, ["a.png", "b.png"]);
    assert.equal(bg.maxCount, 5);
  });

  it("calls Logitech's default (or a picture not saved here) the default", () => {
    assert.equal(readBackground(settings()).isDefault, true);
    assert.equal(readBackground(settings(["a.png"], ["somewhere-else.png"])).isDefault, true);
    assert.equal(readBackground(settings(["a.png"], [])).isDefault, true);
  });

  it("is null when the hub has no screen remote settings", () => {
    assert.equal(readBackground(null), null);
    assert.equal(readBackground({ Settings: [] }), null);
    assert.equal(readBackground({ Settings: [{ Name: "BackgroundImage", Values: [] }] }), null);
  });

  it("only links pictures with a name the hub serves", () => {
    assert.equal(pictureBase("12345678_ab-cd.png"), "12345678_ab-cd");
    assert.equal(pictureUrl("ab-cd.png"), "/api/remote-background/image?name=ab-cd");
    assert.equal(pictureUrl("ab-cd.png", { small: true }), "/api/remote-background/image?name=ab-cd_small");
    for (const bad of ["../x.png", "x.jpg", "x y.png", "", null, `${"a".repeat(97)}.png`]) {
      assert.equal(pictureUrl(bad), "", String(bad));
    }
  });

  it("fills the 3:4 screen: the largest 3:4 area, centred", () => {
    assert.deepEqual(cropRect(240, 320), { x: 0, y: 0, width: 240, height: 320 });
    const wide = cropRect(1600, 900);
    assert.equal(wide.height, 900);
    assert.equal(wide.width, 675);
    assert.equal(wide.x, (1600 - 675) / 2);
    const tall = cropRect(971, 1619);
    assert.equal(tall.width, 971);
    assert.ok(Math.abs(tall.height - 971 * 4 / 3) < 1e-9);
    assert.ok(Math.abs(tall.y - (1619 - tall.height) / 2) < 1e-9);
  });

  it("zooms in and pans within the picture, never past its edges", () => {
    const z = cropRect(1600, 900, { zoom: 2 });
    assert.equal(z.width, 337.5);
    assert.equal(z.height, 450);
    const left = cropRect(1600, 900, { zoom: 2, panX: -1, panY: -1 });
    assert.equal(left.x, 0);
    assert.equal(left.y, 0);
    const right = cropRect(1600, 900, { zoom: 2, panX: 5, panY: 5 });
    assert.equal(right.x + right.width, 1600);
    assert.equal(right.y + right.height, 900);
    assert.equal(cropRect(1600, 900, { zoom: 99 }).width, 675 / 4);
  });

  it("drags the picture with the pointer", () => {
    const pan = { zoom: 1, panX: 0, panY: 0 };
    const rect = cropRect(1600, 900, pan);
    const moved = dragPan(pan, rect, 1600, 900, 30, 0, 120);
    assert.ok(moved.panX < 0, "dragging right shows more of the left");
    assert.equal(moved.panY, 0, "no room to move up or down");
    assert.equal(dragPan(pan, rect, 1600, 900, -100000, 0, 120).panX, 1);
  });

  it("builds the upload body and the messages", () => {
    assert.deepEqual(uploadRequest("data:image/png;base64,AA==", "data:image/png;base64,BB=="),
      { action: "upload", image: "data:image/png;base64,AA==", thumbnail: "data:image/png;base64,BB==" });
    assert.match(savedMessage({ ok: true }), /Sync remote/);
    assert.equal(savedMessage({ ok: false, error: "The picture isn't a PNG." }), "The picture isn't a PNG.");
    assert.deepEqual(SCREEN, { width: 240, height: 320 });
    assert.deepEqual(THUMBNAIL, { width: 60, height: 80 });
  });
});

/* The Remotes page re-renders on every hub update. The Background card must
   survive that: on the hub a file picked while the page re-rendered went to a
   detached input and was lost, and a drag or zoom broke mid-gesture. */
describe("remote background card survives the page's re-renders", () => {
  const view = readFileSync(new URL("../public/js/views/remotes.js", import.meta.url), "utf8");

  it("keeps the file input outside the re-rendered page", () => {
    assert.doesNotMatch(view, /<input[^>]*type="file"/, "no file input in the rendered markup");
    assert.match(view, /fileInput\s*=\s*document\.createElement\("input"\)/);
    assert.match(view, /section\.append\(fileInput\)/);
  });

  it("puts the card's own element back instead of rebuilding it", () => {
    assert.match(view, /<div data-bg-slot><\/div>/);
    assert.match(view, /querySelector\("\[data-bg-slot\]"\)\?\.replaceWith\(backgroundHost\)/);
    const card = view.slice(view.indexOf("function backgroundCard()"), view.indexOf("/* One section per model"));
    assert.doesNotMatch(card, /[^a-zA-Z]render\(\)/, "background code redraws only its card");
  });
});

/* -- the simulator, like the hub ----------------------------------------- */

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 19000 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

const post = (path, body, headers = {}) => fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const getJson = async (path) => (await fetch(`${BASE}${path}`)).json();

// The header the hub checks: signature, IHDR, width, height, bit depth and
// colour type (6 = RGBA, what a browser canvas writes).
function png(width, height, colourType = 6) {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = colourType;
  return `data:image/png;base64,${b.toString("base64")}`;
}
const upload = () => post("/api/remote-background", uploadRequest(png(240, 320), png(60, 80)));

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

describe("simulator remote background", () => {
  it("starts on Logitech's default with no saved pictures", async () => {
    const bg = readBackground((await getJson("/api/remote-background")).settings);
    assert.equal(bg.isDefault, true);
    assert.deepEqual(bg.pictures, []);
  });

  it("saves an upload, serves it and its thumbnail, and makes it the background", async () => {
    const reply = await upload();
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).ok, true);
    const bg = readBackground((await getJson("/api/remote-background")).settings);
    assert.equal(bg.isDefault, false);
    assert.deepEqual(bg.pictures, [bg.current]);
    for (const small of [false, true]) {
      const image = await fetch(`${BASE}${pictureUrl(bg.current, { small })}`);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get("content-type"), "image/png");
    }
  });

  it("keeps the newest five pictures and drops the oldest one's files", async () => {
    for (let i = 0; i < 6; i++) await upload();
    const bg = readBackground((await getJson("/api/remote-background")).settings);
    assert.equal(bg.pictures.length, 5);
    assert.equal(bg.pictures[0], bg.current);
    assert.equal((await fetch(`${BASE}/api/remote-background/image?name=00000000-0000-4000-8000-000000000001`)).status, 404);
  });

  it("switches to a saved picture and back to the default", async () => {
    await upload();
    await upload();
    let bg = readBackground((await getJson("/api/remote-background")).settings);
    const older = bg.pictures[1];
    assert.equal((await post("/api/remote-background", { action: "select", image: older })).status, 200);
    bg = readBackground((await getJson("/api/remote-background")).settings);
    assert.equal(bg.current, older);
    assert.equal((await post("/api/remote-background", { action: "default" })).status, 200);
    bg = readBackground((await getJson("/api/remote-background")).settings);
    assert.equal(bg.isDefault, true);
    assert.equal(bg.pictures.length, 2);
  });

  it("refuses wrong sizes, non-PNGs, unknown pictures and actions", async () => {
    const wrong = await post("/api/remote-background", uploadRequest(png(320, 240), png(60, 80)));
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /must be 240x320/);
    const thumb = await post("/api/remote-background", uploadRequest(png(240, 320), png(80, 60)));
    assert.match((await thumb.json()).error, /must be 60x80/);
    const rgb = await post("/api/remote-background", uploadRequest(png(240, 320, 2), png(60, 80)));
    assert.equal(rgb.status, 400);
    assert.match((await rgb.json()).error, /8-bit RGBA PNG/);
    const notPng = await post("/api/remote-background", uploadRequest("data:image/png;base64,R0lGODlh", png(60, 80)));
    assert.match((await notPng.json()).error, /isn't a PNG|isn't base64/);
    assert.equal((await post("/api/remote-background", { action: "select", image: "nope.png" })).status, 422);
    assert.equal((await post("/api/remote-background", { action: "select", image: "../x.png" })).status, 400);
    assert.equal((await post("/api/remote-background", { action: "rotate" })).status, 400);
    assert.equal((await fetch(`${BASE}/api/remote-background/image?name=..%2Fx`)).status, 400);
    const bg = readBackground((await getJson("/api/remote-background")).settings);
    assert.equal(bg.isDefault, true);
    assert.deepEqual(bg.pictures, []);
  });

  it("takes changes only as JSON from the hub's own pages", async () => {
    const cross = await post("/api/remote-background", { action: "default" }, { Origin: "http://evil.example" });
    assert.equal(cross.status, 403);
    const text = await fetch(`${BASE}/api/remote-background`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "default" }),
    });
    assert.equal(text.status, 403);
  });

  it("lists remote-background among the hub's features", async () => {
    assert.ok((await getJson("/api/version")).features.includes("remote-background"));
  });
});
