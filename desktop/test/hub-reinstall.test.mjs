import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { reinstallHub, sourceVerdict } = require("../src/hub-reinstall.js");

const HUB = { host: "10.0.0.20", port: 8080 };
const RELEASE = { version: "2.1.0", tag: "v2.1.0", url: "x", assets: {} };

/** Run the action with scripted dialog answers (button labels); records what was asked and what ran. */
async function run({ hubVersion, answers, latest = { release: RELEASE, error: "" }, zip = null, zipError = null, result = null, updateError = null }) {
  const dialogs = [];
  const updates = [];
  let started = 0;
  const queue = [...answers];
  const outcome = await reinstallHub({
    hub: HUB,
    keyPath: "/home/me/.ssh/harmony_owner_ed25519",
    keyLabel: "~/.ssh/harmony_owner_ed25519",
    getHubVersion: async () => hubVersion,
    getLatestRelease: async () => latest,
    pickZip: async () => (zip ? `/downloads/${zip.name}` : null),
    readZip: async () => {
      if (zipError) throw new Error(zipError);
      return { version: zip.version, files: [] };
    },
    update: async (options) => {
      updates.push(options);
      if (updateError) throw new Error(updateError);
      return typeof result === "function" ? result(options) : result;
    },
    showMessage: async (options) => {
      dialogs.push(options);
      if (!options.buttons) return { response: 0 };
      const label = queue.shift();
      const response = options.buttons.indexOf(label);
      assert.notEqual(response, -1, `no "${label}" button among ${options.buttons.join(" | ")}`);
      return { response };
    },
    onStart: () => { started += 1; },
  });
  assert.equal(queue.length, 0, "every scripted answer was asked for");
  return { outcome, dialogs, updates, started };
}

test("compares the source's version with the hub's", () => {
  assert.equal(sourceVerdict({ version: "2.0.0" }, "2.0.0"), "same");
  assert.equal(sourceVerdict({ version: "2.0.0" }, "2.1.0"), "newer");
  assert.equal(sourceVerdict({ version: "2.10.0" }, "2.9.0"), "older");
  assert.equal(sourceVerdict({ legacy: true }, "2.1.0"), "newer");
  assert.equal(sourceVerdict(null, "2.1.0"), "unknown");
  assert.equal(sourceVerdict({ version: "2.0.0" }, "dev"), "unknown");
});

test("an up-to-date hub can still be repaired from the latest release", async () => {
  const { outcome, dialogs, updates, started } = await run({
    hubVersion: { version: "2.1.0" },
    answers: ["Latest GitHub Release", "Repair"],
    result: { ok: true, alreadyCurrent: true, total: 30 },
  });
  assert.equal(outcome.alreadyCurrent, true);
  assert.equal(started, 1);
  assert.match(dialogs[0].detail, /The hub at 10\.0\.0\.20 runs Melodious 2\.1\.0\./);
  assert.equal(dialogs[1].message, "Reinstall Melodious 2.1.0 on the hub?");
  assert.match(dialogs[1].detail, /GitHub release v2\.1\.0 is Melodious 2\.1\.0, the same version\./);
  assert.match(dialogs[1].detail, /~\/\.ssh\/harmony_owner_ed25519/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].release, RELEASE);
  assert.equal(updates[0].payload, null);
  assert.equal(updates[0].force, false);
  assert.equal(dialogs[2].message, "Nothing to repair");
  assert.match(dialogs[2].detail, /All 30 hub files match Melodious 2\.1\.0/);
});

test("Reinstall All Files forces every file from a chosen zip", async () => {
  const { dialogs, updates } = await run({
    hubVersion: { version: "2.0.0" },
    answers: ["Choose a Hub Zip…", "Reinstall All Files"],
    zip: { name: "melodious-hub-2.0.0.zip", version: "2.0.0" },
    result: { ok: true, rebooted: true, version: "2.0.0", total: 30, replaced: 30 },
  });
  assert.match(dialogs[1].detail, /melodious-hub-2\.0\.0\.zip is Melodious 2\.0\.0, the same version\./);
  assert.match(dialogs[1].detail, /isn't checked against GitHub/);
  assert.equal(updates[0].force, true);
  assert.equal(updates[0].release, null);
  assert.equal(updates[0].payload.version, "2.0.0");
  assert.equal(dialogs[2].message, "The hub's software was reinstalled");
  assert.equal(dialogs[2].detail, "30 files were replaced and the hub restarted. It reports Melodious 2.0.0.");
});

test("an older source needs an explicit Downgrade, and Cancel is the default", async () => {
  const older = { hubVersion: { version: "2.2.0" }, zip: { name: "melodious-hub-2.1.0.zip", version: "2.1.0" } };
  const refused = await run({ ...older, answers: ["Choose a Hub Zip…", "Cancel"] });
  assert.deepEqual(refused.outcome, { ok: false, cancelled: true });
  assert.equal(refused.updates.length, 0);
  assert.equal(refused.started, 0);
  const ask = refused.dialogs[1];
  assert.equal(ask.type, "warning");
  assert.equal(ask.message, "Downgrade the hub to Melodious 2.1.0?");
  assert.match(ask.detail, /runs Melodious 2\.2\.0\. melodious-hub-2\.1\.0\.zip is Melodious 2\.1\.0, which is older\./);
  assert.deepEqual(ask.buttons, ["Cancel", "Downgrade"]);
  assert.equal(ask.defaultId, 0);
  assert.equal(ask.cancelId, 0);

  const agreed = await run({
    ...older,
    answers: ["Choose a Hub Zip…", "Downgrade"],
    result: { ok: true, rebooted: true, version: "2.1.0", total: 30, replaced: 12 },
  });
  assert.equal(agreed.updates.length, 1);
  assert.equal(agreed.updates[0].force, false);
  assert.equal(agreed.updates[0].confirmChange, null);

  // The same holds for the latest release when the hub is ahead of it.
  const ahead = await run({ hubVersion: { version: "2.2.0" }, answers: ["Latest GitHub Release", "Cancel"] });
  assert.equal(ahead.dialogs[1].message, "Downgrade the hub to Melodious 2.1.0?");
  assert.equal(ahead.updates.length, 0);
});

test("a hub that doesn't report a version is never changed without a warning", async () => {
  const { dialogs, updates } = await run({ hubVersion: null, answers: ["Latest GitHub Release", "Cancel"] });
  assert.match(dialogs[0].detail, /isn't answering, so its version is unknown/);
  assert.equal(dialogs[1].type, "warning");
  assert.match(dialogs[1].detail, /If the hub runs something newer, this is a downgrade\./);
  assert.deepEqual(dialogs[1].buttons, ["Cancel", "Install"]);
  assert.equal(dialogs[1].defaultId, 0);
  assert.equal(updates.length, 0);
});

test("a newer source is offered as an update, with the built-from-source caveat", async () => {
  const { dialogs, updates } = await run({
    hubVersion: { version: "2.0.0" },
    answers: ["Latest GitHub Release", "Update"],
    result: { ok: true, rebooted: false, version: "2.1.0", total: 30, replaced: 1 },
  });
  assert.equal(dialogs[1].message, "Update the hub to Melodious 2.1.0?");
  assert.match(dialogs[1].detail, /If the hub runs a build made from source after 2\.0\.0, this replaces it with the release\./);
  assert.equal(updates[0].confirmChange, null);
  assert.equal(dialogs[2].detail, "1 file was replaced. It reports Melodious 2.1.0.");

  const legacy = await run({ hubVersion: { legacy: true }, answers: ["Latest GitHub Release", "Cancel"] });
  assert.match(legacy.dialogs[1].detail, /runs Melodious 1\.2 or older\./);
  assert.doesNotMatch(legacy.dialogs[1].detail, /built|build made/);
});

test("equal versions with different files ask before replacing them", async () => {
  const differing = Array.from({ length: 10 }, (_, i) => ({ dest: `/data/codex/bin/file${i}` }));
  const scripted = (answer) => run({
    hubVersion: { version: "2.0.0" },
    answers: ["Choose a Hub Zip…", "Repair", answer],
    zip: { name: "melodious-hub-2.0.0.zip", version: "2.0.0" },
    result: async ({ confirmChange }) => {
      assert.equal(await confirmChange({ differing: [], total: 30 }), true, "identical files need no question");
      return (await confirmChange({ differing, total: 30 }))
        ? { ok: true, rebooted: false, version: "2.0.0", total: 30, replaced: 10 }
        : { ok: false, cancelled: true, total: 30 };
    },
  });
  const no = await scripted("Cancel");
  assert.equal(no.outcome.cancelled, true);
  assert.equal(no.dialogs.length, 3, "a cancelled change ends without another dialog");
  const ask = no.dialogs[2];
  assert.equal(ask.type, "warning");
  assert.equal(ask.message, "10 files on the hub differ from this source");
  assert.match(ask.detail, /Both report Melodious 2\.0\.0, so the version can't say which is newer\./);
  assert.match(ask.detail, /10 of 30: file0, file1, file2, file3, file4, file5, file6, file7, …$/);
  assert.deepEqual(ask.buttons, ["Cancel", "Replace 10 Files"]);
  assert.equal(ask.defaultId, 0);

  const yes = await scripted("Replace 10 Files");
  assert.equal(yes.outcome.ok, true);
  assert.equal(yes.dialogs[3].message, "The hub's software was reinstalled");
});

test("backing out or a bad source changes nothing", async () => {
  const cancel = await run({ hubVersion: { version: "2.0.0" }, answers: ["Cancel"] });
  assert.deepEqual(cancel.outcome, { ok: false, cancelled: true });
  assert.equal(cancel.dialogs.length, 1);

  const noFile = await run({ hubVersion: { version: "2.0.0" }, answers: ["Choose a Hub Zip…"] });
  assert.deepEqual(noFile.outcome, { ok: false, cancelled: true });

  const badZip = await run({
    hubVersion: { version: "2.0.0" },
    answers: ["Choose a Hub Zip…"],
    zip: { name: "photos.zip", version: "" },
    zipError: "That isn't a Melodious hub zip: it has no melodious-hub-<version> folder.",
  });
  assert.equal(badZip.outcome.ok, false);
  assert.equal(badZip.dialogs[1].message, "Melodious can't use that zip");
  assert.equal(badZip.updates.length, 0);

  const noRelease = await run({
    hubVersion: { version: "2.0.0" },
    answers: ["Latest GitHub Release"],
    latest: { release: null, error: "Couldn't reach GitHub." },
  });
  assert.equal(noRelease.dialogs[1].message, "Couldn't get the latest hub release");
  assert.equal(noRelease.dialogs[1].detail, "Couldn't reach GitHub.");
  assert.equal(noRelease.updates.length, 0);

  const failed = await run({
    hubVersion: { version: "2.1.0" },
    answers: ["Latest GitHub Release", "Repair"],
    updateError: "Couldn't reach the hub over SSH (port 22).",
  });
  assert.equal(failed.outcome.error, "Couldn't reach the hub over SSH (port 22).");
  assert.equal(failed.dialogs[2].message, "The hub's software wasn't reinstalled");
});
