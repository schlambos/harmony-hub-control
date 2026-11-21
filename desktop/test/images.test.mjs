// Remote images (catalog/images.js): only Logitech's activity icon and
// channel logo addresses are fetched, the answer must be a PNG of at most
// 512 KB, and the IPC channel keeps the sender check. fetch is stubbed; no
// network.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_LOGO_HOST,
  imageSourceUrl,
  createImageFetcher,
} = require("../src/catalog/images.js");
const { CATALOG_CHANNELS, createCatalogIpcHandlers } = require("../src/ipc.js");

function png(width = 70, height = 70, extra = 0) {
  const b = Buffer.alloc(40 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function stubFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (answer instanceof Error) throw answer;
    const { status = 200, body = png(), length } = answer;
    return {
      status,
      headers: { get: (name) => (name === "content-length" && length !== undefined ? String(length) : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };
  return { fetchImpl, calls };
}

const ACTIVITY = "https://rcbu-example.myharmony.com/Activity/123_ab-cd.png";
const LOGO = "content-image://1.0/image/0bab-11.png";

test("only activity icon and channel logo addresses are fetched", () => {
  assert.equal(imageSourceUrl(ACTIVITY), ACTIVITY);
  assert.equal(imageSourceUrl("https://rcbu-prod-ssl-eu.myharmony.com/Activity/1_x_small.png"),
    "https://rcbu-prod-ssl-eu.myharmony.com/Activity/1_x_small.png");
  assert.equal(imageSourceUrl(LOGO, "https://logos.cloudfront.net"),
    "https://logos.cloudfront.net/1.0/image/0bab-11.png;maxX=54;maxY=54");
  assert.equal(imageSourceUrl(LOGO), `${DEFAULT_LOGO_HOST}/1.0/image/0bab-11.png;maxX=54;maxY=54`);
  assert.equal(imageSourceUrl(LOGO, "https://evil.example.com"), `${DEFAULT_LOGO_HOST}/1.0/image/0bab-11.png;maxX=54;maxY=54`);
  for (const bad of [
    "http://rcbu-example.myharmony.com/Activity/1_x.png",
    "https://myharmony.com.evil.example/Activity/1_x.png",
    "https://evil.example/Activity/1_x.png",
    "https://rcbu-example.myharmony.com/UserImages/100/x.png",
    "https://rcbu-example.myharmony.com/Activity/../x.png",
    "https://rcbu-example.myharmony.com/Activity/x.png?y=1",
    "content-image://1.0/station/0bab/image",
    "content-image://1.0/image/../x.png",
    "file:///etc/passwd",
    "",
    null,
  ]) {
    assert.equal(imageSourceUrl(bad, "https://logos.cloudfront.net"), null, String(bad));
  }
});

test("a PNG comes back as a data URL; the request refuses redirects", async () => {
  const { fetchImpl, calls } = stubFetch({ body: png(38, 38) });
  const res = await createImageFetcher({ fetchImpl }).fetch({ uri: ACTIVITY });
  assert.match(res.image, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(res.image.split(",")[1], "base64").readUInt32BE(16), 38);
  assert.equal(calls[0].url, ACTIVITY);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.method, "GET");
});

test("missing, oversized, non-PNG and unreachable images give plain errors", async () => {
  const fetcher = (answer) => createImageFetcher({ fetchImpl: stubFetch(answer).fetchImpl });
  await assert.rejects(fetcher({ status: 404 }).fetch({ uri: ACTIVITY }), /no longer has this image/);
  await assert.rejects(fetcher({ status: 500 }).fetch({ uri: ACTIVITY }), /answered 500/);
  await assert.rejects(fetcher({ length: 600000 }).fetch({ uri: ACTIVITY }), /larger than 512 KB/);
  await assert.rejects(fetcher({ body: png(70, 70, 512 * 1024) }).fetch({ uri: ACTIVITY }), /larger than 512 KB/);
  await assert.rejects(fetcher({ body: Buffer.from("GIF89a".padEnd(40, "x")) }).fetch({ uri: ACTIVITY }), /isn't a PNG/);
  await assert.rejects(fetcher(new Error("ECONNRESET")).fetch({ uri: ACTIVITY }), /Could not reach rcbu-example\.myharmony\.com/);
  await assert.rejects(fetcher({}).fetch({ uri: "https://evil.example/x.png" }), /Invalid image address/);
  await assert.rejects(fetcher({}).fetch({ uri: ACTIVITY, extra: 1 }), /Invalid image arguments/);
  await assert.rejects(fetcher({}).fetch("nope"), /Invalid image arguments/);
});

test("a streamed body is read in chunks and cut off past 512 KB", async () => {
  const streamed = (chunks) => {
    let cancelled = false;
    let read = 0;
    const fetchImpl = async () => ({
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({
        read: async () => (read < chunks.length ? { done: false, value: chunks[read++] } : { done: true }),
        cancel: async () => { cancelled = true; },
      }) },
      arrayBuffer: async () => { throw new Error("the whole body must not be read"); },
    });
    return { fetchImpl, state: () => ({ cancelled, read }) };
  };
  const image = png(54, 50);
  const ok = streamed([new Uint8Array(image.subarray(0, 10)), new Uint8Array(image.subarray(10))]);
  const res = await createImageFetcher({ fetchImpl: ok.fetchImpl }).fetch({ uri: ACTIVITY });
  assert.deepEqual(Buffer.from(res.image.split(",")[1], "base64"), image);

  const block = new Uint8Array(200 * 1024);
  const big = streamed([block, block, block, block, block]);
  await assert.rejects(createImageFetcher({ fetchImpl: big.fetchImpl }).fetch({ uri: ACTIVITY }), /larger than 512 KB/);
  assert.deepEqual(big.state(), { cancelled: true, read: 3 });
});

test("catalog:remote-image keeps the sender check and passes plain errors", async () => {
  const mainWin = {
    isDestroyed: () => false,
    webContents: { mainFrame: { url: "melodious://app/#editor" } },
  };
  mainWin.webContents.mainFrame.top = mainWin.webContents.mainFrame;
  const trusted = { sender: mainWin.webContents, senderFrame: mainWin.webContents.mainFrame };
  const handlers = createCatalogIpcHandlers({
    getMainWindow: () => mainWin,
    getCatalogService: () => null,
    imageFetcher: createImageFetcher({ fetchImpl: stubFetch({ status: 404 }).fetchImpl }),
  });
  const handler = handlers[CATALOG_CHANNELS.remoteImage];
  await assert.rejects(handler({ sender: {}, senderFrame: {} }, { uri: ACTIVITY }), /Untrusted IPC sender/);
  await assert.rejects(handler(trusted, { uri: ACTIVITY }), /^Error: Logitech no longer has this image$/);
  await assert.rejects(handler(trusted, { uri: "https://evil.example/x.png" }), /^Error: Invalid image address$/);
  const ok = createCatalogIpcHandlers({
    getMainWindow: () => mainWin,
    imageFetcher: createImageFetcher({ fetchImpl: stubFetch({}).fetchImpl }),
  })[CATALOG_CHANNELS.remoteImage];
  assert.match((await ok(trusted, { uri: LOGO, contentImageHost: "https://logos.cloudfront.net" })).image, /^data:image\/png;base64,/);
});
