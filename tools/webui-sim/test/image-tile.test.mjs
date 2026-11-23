// Activity image tiles (ui/shell.js imageTile) and the icon picker's
// glyphs (vendor/activity-ui.js), which must stay the shell's own icons.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

describe("image tiles", () => {
  it("stop asking for an image the hub didn't have, until images change", async () => {
    const handlers = {};
    const previous = globalThis.document;
    globalThis.document = { addEventListener: (type, fn) => { handlers[type] = fn; } };
    let shell;
    try {
      shell = await import(`../public/js/ui/shell.js?image-tile=${Date.now()}`);
    } finally {
      globalThis.document = previous;
    }
    const url = "/api/remote-images/image?name=1_ab";
    const withImage = shell.imageTile(url, "tv", { size: 48 });
    assert.match(withImage, /<img class="m-tile-img" src="\/api\/remote-images\/image\?name=1_ab"/);
    assert.match(withImage, /<svg/);
    assert.equal(shell.imageTile("", "tv", { size: 48 }), shell.iconTile("tv", { size: 48 }));

    let removed = false;
    handlers.error({ target: { tagName: "IMG", classList: { contains: (c) => c === "m-tile-img" },
      getAttribute: () => url, remove: () => { removed = true; } } });
    assert.equal(removed, true);
    assert.equal(shell.imageTile(url, "tv", { size: 48 }), shell.iconTile("tv", { size: 48 }));
    assert.match(shell.imageTile("/api/remote-images/image?name=2_cd", "tv"), /<img/);

    handlers.error({ target: { tagName: "IMG", classList: { contains: () => false }, getAttribute: () => "/other.png", remove() {} } });
    handlers["melodious:images-changed"]();
    assert.match(shell.imageTile(url, "tv", { size: 48 }), /<img/);
  });

  it("hide their icon while the image is in the tile, so a transparent image doesn't show it", () => {
    const css = readFileSync(new URL("../public/css/app.css", import.meta.url), "utf8");
    assert.match(css, /\n\.m-tile--image:has\(\.m-tile-img\) > \.ic \{\s*visibility: hidden;\s*\}/);
  });
});

describe("icon picker glyphs", () => {
  it("are the shell's own icon paths", () => {
    const context = { __HARMONY_ACTIVITY_TEST__: {} };
    vm.createContext(context);
    vm.runInContext(readFileSync(new URL("../public/vendor/activity-ui.js", import.meta.url), "utf8"), context);
    const { ICON_GLYPHS } = context.__HARMONY_ACTIVITY_TEST__.api;
    const icons = readFileSync(new URL("../public/js/ui/icons.js", import.meta.url), "utf8");
    assert.ok(ICON_GLYPHS.length >= 10);
    for (const glyph of ICON_GLYPHS) {
      const body = new RegExp(`\\n  ${glyph.key}: '([^']*)'`).exec(icons)?.[1];
      assert.ok(body, `${glyph.key} is in icons.js`);
      const paths = [...body.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]).join(" ");
      assert.equal(glyph.d, paths, `${glyph.key} matches icons.js`);
    }
  });
});
