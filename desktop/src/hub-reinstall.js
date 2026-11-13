"use strict";

// "Reinstall / repair hub software…": put a hub release back on the hub
// whatever version it reports. The user picks the source (the latest GitHub
// release, or a hub zip on this computer), sees the hub's version next to the
// source's, and must say "Downgrade" before an older source goes on. The
// work itself is hub-update.js's updateHub(): same SSH, key, transaction and
// rollback as "Update hub…".
//
// Every question is a dialog asked through showMessage, so the page that
// starts this passes nothing in and learns only the outcome.

const path = require("node:path");
const { compareVersions, parseVersion } = require("./updates");

/**
 * How the source's version sits against the hub's. `hub` is { version },
 * { legacy: true } (1.2 or older) or null when the hub didn't answer.
 * "same" | "newer" | "older" | "unknown".
 */
function sourceVerdict(hub, sourceVersion) {
  if (!hub) return "unknown";
  if (hub.legacy) return "newer";
  if (!parseVersion(hub.version) || !parseVersion(sourceVersion)) return "unknown";
  const cmp = compareVersions(sourceVersion, hub.version);
  return cmp === 0 ? "same" : cmp > 0 ? "newer" : "older";
}

function hubVersionText(hub) {
  if (!hub) return "an unknown version";
  return hub.legacy ? "Melodious 1.2 or older" : `Melodious ${hub.version}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Run the whole action. Returns updateHub()'s result, or { ok: false,
 * cancelled: true } when the user backs out, or { ok: false, error }.
 *
 *   hub               { host, port } of the connected hub
 *   keyPath           the hub SSH key (hub-update.js findHubKey)
 *   keyLabel          how to show that path
 *   getHubVersion     async () => { version } | { legacy: true } | null
 *   getLatestRelease  async () => { release, error } (updates.js latestHub)
 *   pickZip           async () => path | null
 *   readZip           hub-update.js readLocalHubZip
 *   update            hub-update.js updateHub, already bound to this hub
 *   showMessage       async (options) => { response }
 *   onStart           called once the user has confirmed and work begins
 */
async function reinstallHub({ hub, keyPath, keyLabel = keyPath, getHubVersion, getLatestRelease, pickZip, readZip, update, showMessage, onStart = () => {} }) {
  const cancelled = { ok: false, cancelled: true };
  const fail = async (message, err) => {
    const error = err?.message || String(err);
    await showMessage({ type: "warning", message, detail: error });
    return { ok: false, error };
  };

  const hubVersion = await getHubVersion();
  const runs = hubVersion
    ? `The hub at ${hub.host} runs ${hubVersionText(hubVersion)}.`
    : `The hub at ${hub.host} isn't answering, so its version is unknown.`;

  const pick = await showMessage({
    type: "question",
    message: "Reinstall or repair the hub's software",
    detail:
      `${runs} Choose where the hub software comes from: the latest release on GitHub, or a hub zip ` +
      "(melodious-hub-<version>.zip) on this computer. To put back what the hub already runs, choose a source " +
      "with the hub's own version. Nothing changes on the hub yet.",
    buttons: ["Latest GitHub Release", "Choose a Hub Zip…", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });
  if (pick.response === 2) return cancelled;

  let source;
  if (pick.response === 0) {
    const { release, error } = await getLatestRelease();
    if (!release) return fail("Couldn't get the latest hub release", error || "GitHub lists no hub release.");
    source = { version: release.version, label: `GitHub release ${release.tag || release.version}`, release, payload: null };
  } else {
    const zipPath = await pickZip();
    if (!zipPath) return cancelled;
    let payload;
    try {
      payload = await readZip(zipPath);
    } catch (err) {
      return fail("Melodious can't use that zip", err);
    }
    source = { version: payload.version, label: path.basename(zipPath), release: null, payload };
  }

  const verdict = sourceVerdict(hubVersion, source.version);
  const how =
    `Melodious installs it on ${hub.host} over SSH with ${keyLabel}, the way the installer does. ` +
    (source.payload
      ? "A zip from this computer isn't checked against GitHub, so use one you built or downloaded yourself. "
      : "The download is checked against the release's SHA256SUMS.txt. ") +
    "Remotes and activities pause for about a minute if the hub restarts. If anything goes wrong, the hub keeps " +
    "its current software. Keep the hub plugged in.";

  let force = false;
  if (verdict === "older" || verdict === "unknown") {
    const older = verdict === "older";
    const { response } = await showMessage({
      type: "warning",
      message: older ? `Downgrade the hub to Melodious ${source.version}?` : `Install Melodious ${source.version} on the hub?`,
      detail:
        (older
          ? `${runs} ${source.label} is Melodious ${source.version}, which is older. Downgrading takes away the ` +
            `features and fixes added since ${source.version}, and the older software may not understand settings the newer one saved.`
          : `${runs} ${source.label} is Melodious ${source.version}. If the hub runs something newer, this is a downgrade.`) +
        `\n\n${how}`,
      buttons: ["Cancel", older ? "Downgrade" : "Install"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return cancelled;
  } else {
    const newer = verdict === "newer";
    const { response } = await showMessage({
      type: "question",
      message: newer ? `Update the hub to Melodious ${source.version}?` : `Reinstall Melodious ${source.version} on the hub?`,
      detail:
        `${runs} ${source.label} is Melodious ${source.version}, ${newer ? "which is newer" : "the same version"}.` +
        (newer && !hubVersion.legacy
          ? ` If the hub runs a build made from source after ${hubVersion.version}, this replaces it with the release.`
          : "") +
        `\n\n${newer ? "Update" : "Repair"} checks every file on the hub and replaces only the ones that differ. ` +
        "Reinstall All Files sends and rewrites every file, then restarts the hub." +
        `\n\n${how}`,
      buttons: [newer ? "Update" : "Repair", "Reinstall All Files", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return cancelled;
    force = response === 1;
  }

  // Two builds can carry one version number (a hub built from source keeps
  // the last release's), so equal versions with different files get their
  // own question before anything is sent.
  const confirmChange = verdict !== "same" ? null : async ({ differing, total }) => {
    if (!differing.length) return true;
    const names = differing.slice(0, 8).map((f) => path.posix.basename(f.dest));
    if (differing.length > names.length) names.push("…");
    const { response } = await showMessage({
      type: "warning",
      message: `${plural(differing.length, "file")} on the hub ${differing.length === 1 ? "differs" : "differ"} from this source`,
      detail:
        `Both report Melodious ${source.version}, so the version can't say which is newer. If the hub was built from ` +
        `source after ${source.version}, replacing its files is a downgrade; if a file on the hub is damaged, this repairs it.` +
        `\n\n${differing.length} of ${total}: ${names.join(", ")}`,
      buttons: ["Cancel", `Replace ${plural(differing.length, "File")}`],
      defaultId: 0,
      cancelId: 0,
    });
    return response === 1;
  };

  onStart();
  let result;
  try {
    result = await update({ release: source.release, payload: source.payload, force, confirmChange });
  } catch (err) {
    return fail("The hub's software wasn't reinstalled", err);
  }
  if (result.cancelled) return result;
  if (result.alreadyCurrent) {
    await showMessage({
      type: "info",
      message: "Nothing to repair",
      detail: `All ${plural(result.total, "hub file")} match Melodious ${source.version}. Nothing was changed.`,
    });
  } else if (result.ok) {
    await showMessage({
      type: "info",
      message: "The hub's software was reinstalled",
      detail:
        `${plural(result.replaced, "file")} ${result.replaced === 1 ? "was" : "were"} replaced` +
        `${result.rebooted ? " and the hub restarted" : ""}. It reports Melodious ${result.version || "1.2 or older"}.`,
    });
  } else {
    await showMessage({ type: "warning", message: "Check the hub", detail: result.message });
  }
  return result;
}

module.exports = { reinstallHub, sourceVerdict };
