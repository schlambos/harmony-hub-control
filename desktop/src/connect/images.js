/* Sync user images from Logitech (docs/REMOTE_IMAGES.md).
 *
 * A screen remote shows activity icons and favorite channel logos that
 * Logitech kept in its cloud. The hub can't reach the cloud, so the desktop
 * app does: it asks the hub which images its activities and favorites use
 * (GET /api/remote-images), downloads the missing ones from Logitech
 * (window.melodiousDesktop.catalog.remoteImage, catalog/images.js) and hands
 * them to the hub over the LAN (POST /api/remote-images).
 *
 * Plain browser script: scheme.js inlines it in the Settings page before
 * connect.js. Tests load it in a VM.
 */
(function (root) {
  "use strict";

  const BATCH_MAX_IMAGES = 64;
  const BATCH_MAX_CHARS = 600 * 1024;
  const MAX_ROUNDS = 200;

  /** fetch(path) as JSON; an Error with .status (and .response) otherwise. */
  async function requestJson(fetchImpl, path, options) {
    const response = await fetchImpl(path, options);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      // Not JSON: an older hub's 404 page, or a proxy error.
    }
    if (!response.ok || !json || json.ok === false) {
      const error = new Error((json && (json.error || json.message)) || text.trim() || `HTTP ${response.status}`);
      error.status = response.status;
      error.response = json;
      throw error;
    }
    return json;
  }

  function createImageSync({ fetchImpl, remoteImage }) {
    const request = (path, options) => requestJson(fetchImpl, path, options);

    /** {state: "ready", missing, total} | {state: "old-hub"} | {state: "error", message} */
    async function status() {
      try {
        const list = await request("/api/remote-images");
        return { state: "ready", missing: Number(list.missing) || 0, total: Number(list.total) || 0 };
      } catch (error) {
        if (error.status === 404) return { state: "old-hub" };
        return { state: "error", message: error.message };
      }
    }

    // POST images to the hub: the names it saved, and why for the others.
    // The hub refuses a whole request when one image in it is bad, so a
    // refused batch is sent again one image at a time.
    async function storeImages(batch) {
      const saved = [];
      const failed = new Map();
      try {
        const result = await request("/api/remote-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images: batch })
        });
        for (const name of Array.isArray(result.saved) ? result.saved : []) saved.push(name);
        for (const item of Array.isArray(result.failed) ? result.failed : []) failed.set(item.name, item.error);
      } catch (error) {
        const reply = error.response && error.response.reply;
        if (error.status === 400 && batch.length > 1) {
          for (const image of batch) {
            const one = await storeImages([image]);
            saved.push(...one.saved);
            for (const [name, reason] of one.failed) failed.set(name, reason);
          }
        } else if (reply && Array.isArray(reply.failed) && reply.failed.length) {
          for (const item of reply.failed) failed.set(item.name, item.error);
        } else {
          for (const image of batch) failed.set(image.name, error.message);
        }
      }
      for (const image of batch) {
        if (!saved.includes(image.name) && !failed.has(image.name)) failed.set(image.name, "not saved");
      }
      return { saved, failed };
    }

    // Download every missing image the hub lists and store them in batches.
    // Missing images come first in the hub's list; asking again with the
    // failures skipped (?offset) reaches all of them.
    // onProgress({done, total}) after each image. -> {synced, failed: Map}
    async function sync(onProgress = () => {}) {
      const failed = new Map();
      let synced = 0;
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const list = await request(`/api/remote-images?offset=${failed.size}`);
        const todo = (Array.isArray(list.images) ? list.images : [])
          .filter((image) => image && !image.stored && image.uri && !failed.has(image.name));
        if (!todo.length) break;
        // The hub's missing count still includes the ones that failed.
        const total = synced + (Number(list.missing) || 0);
        const batch = [];
        let size = 0;
        for (const image of todo) {
          try {
            const answer = await remoteImage({ uri: image.uri, contentImageHost: list.contentImageHost || null });
            batch.push({ name: image.name, image: answer.image });
            size += answer.image.length;
          } catch (error) {
            failed.set(image.name, error.message);
          }
          onProgress({ done: synced + failed.size + batch.length, total: Math.max(total, synced + failed.size + batch.length) });
          if (batch.length >= BATCH_MAX_IMAGES || size > BATCH_MAX_CHARS) break;
        }
        if (!batch.length) continue;
        const stored = await storeImages(batch);
        synced += stored.saved.length;
        for (const [name, reason] of stored.failed) failed.set(name, reason);
      }
      return { synced, failed };
    }

    /** A finished sync for the user: {text, tone} with tone "ok" (all
        synced), "warn" (some failed) or "error" (nothing synced). */
    function summary({ synced, failed }) {
      const reasons = [...new Set(failed.values())];
      let text = synced ? `Synced ${synced}. Run Sync remote on each remote.` : "Nothing synced.";
      if (failed.size) text += ` ${failed.size} failed: ${reasons.slice(0, 2).join("; ")}.`;
      return { text, tone: !synced ? "error" : failed.size ? "warn" : "ok" };
    }

    return { status, sync, storeImages, summary };
  }

  root.melodiousImageSync = { createImageSync, requestJson };
})(typeof window !== "undefined" ? window : globalThis);
