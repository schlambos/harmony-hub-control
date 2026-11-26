/* Backup view: owner-bundle restore points, per-resource exports, and a
   guarded /import restore with client-side shape and size preflight.
   Exports are direct same-origin anchors (the hub streams the files).
   Restores POST form-urlencoded through postHubForm — never JSON — and
   every target passes a two-step dangerGuard; DeviceList.json and the
   full bundle additionally demand a typed phrase, because both write
   DeviceList.json — the file that carries IsKeyboardAssociated and other
   paired-remote Bluetooth flags. A foreign list can reset those flags and
   stop the handset from transmitting for keyboard devices. The bundle also
   writes every other resource and setting, so it carries the same
   device-list risk plus more.
   Resource and bundle restores stay locked until GET /api/config-ready says
   the hub is ready (it refuses them with 503 before that): a restore that
   lands before the hub's first-boot setup leaves the engine without an
   account and every command failing. "Restore without waiting" sends
   force=1, the way out when the hub can never become ready.
   Safe DOM only: dynamic values go through textContent / el(). */

import { getConfigReady, postHubForm, getText } from "../api.js";
import { clear, dangerGuard, el, notice, setText, viewHead } from "../setup-kit.js";
import {
  BUNDLE_FILES,
  FORCE_CONSEQUENCE,
  IMPORT_LABELS,
  RESOURCES,
  exportHref,
  formatBytes,
  importReadiness,
  preflightImport,
  readyPollDelay,
  utf8ByteLength,
} from "./backup-model.js";

/* Layout built from design tokens only — no raw lengths. */
const ROW_STYLE = "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-3);align-items:center;padding:var(--space-2) 0;border-bottom:1px solid var(--border-default)";
const ROW_NO_BORDER_STYLE = "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-3);align-items:center;padding:var(--space-2) 0";
const MANIFEST_STYLE = "display:grid;margin:var(--space-2) 0 var(--space-3)";
const MANIFEST_ITEM_STYLE = "display:flex;align-items:center;gap:var(--space-2);padding:var(--space-1) 0";

const DEVICES_PHRASE = "replace devices";

/* The bundle writes DeviceList.json (same paired-remote flag risk as the
   devices target) plus every other resource and setting, so it requires
   the same typed confirmation as devices. */
const BUNDLE_PHRASE = "replace everything";

const TARGET_HINTS = {
  bundle: "Replaces every resource and setting file on the hub, including Wi-Fi and the cloud blocker flag. A bundle that embeds a cloud-blocker.conf disable value (0/off/false/disabled) is rejected before upload.",
  devices: "This import is the hub's only writer of DeviceList.json. A foreign list can reset Bluetooth IsKeyboardAssociated flags and stop the paired remote from transmitting for those devices.",
  wifi: "Saved immediately; the new network only takes effect after a reboot.",
  cloud: "Only values that enable the blocker (1, on, true, enabled) are accepted here — this page never sends 0/off.",
  restrictions: "Replaces every activity's time restrictions; a file with no activities lifts them all.",
};

const PLACEHOLDERS = {
  bundle: '{"format":"harmony-owner-bundle-v2","files":{ … }}',
  devices: '{"DevicesWithFeatures":[ … ]}',
  functions: '{"FunctionMaps":[ … ]}',
  protocols: '{"Protocols":[ … ]}',
  activities: '{"Activities":[ … ]}',
  maps: '{"ButtonMaps":[ … ]}',
  automation: '{ … }',
  mqtt: '{"broker":{ … },"baseTopic":"harmony/living-room"}',
  wifi: 'network={\n    ssid="LivingRoom"\n    psk=…\n}',
  cloud: "1",
  bluetooth: '{"devices":[ … ]}',
  restrictions: '{"version":1,"activities":{"<id>":[{"days":["sat","sun"],"start":"06:00","end":"09:00"}]}}',
};

function consequenceFor(target) {
  switch (target) {
    case "devices":
      return "Replaces DeviceList.json — the hub's only writer of that file. A wrong list can reset Bluetooth IsKeyboardAssociated flags and stop the paired remote from transmitting for those devices. An automatic backup of the current list is kept on the hub's 5 MiB flash first.";
    case "bundle":
      return "Overwrites every resource and setting on the hub: devices, functions, protocols, activities, maps, automation, MQTT, Wi-Fi, Bluetooth, time restrictions, and the cloud blocker flag. A bundle that tries to disable the cloud blocker is rejected before upload. Wi-Fi changes apply on reboot.";
    case "wifi":
      return "Overwrites wpa_supplicant.conf. It is saved immediately but only takes effect after a reboot — a wrong PSK drops the hub off the network.";
    case "cloud":
      return "Turns the Logitech cloud blocker on and applies its egress mode. This page can only enable the blocker, never disable it.";
    case "mqtt":
      return "Overwrites the MQTT config, including broker credentials.";
    case "bluetooth":
      return "Replaces the saved Bluetooth device list.";
    case "restrictions":
      return "Replaces when each activity can't be started. Activities missing from the file can be started at any time afterwards.";
    default:
      return `Overwrites ${IMPORT_LABELS[target] ?? target} on the hub. An automatic timestamped backup of the current file is kept first.`;
  }
}

export function createBackupView(section) {
  let guard = null;       // { disarm } for the armed restore guard
  let guardButton = null; // the button the guard currently owns
  let generation = 0;     // invalidates stale async replies after re-show

  /* -- Export: owner bundle (the one amber primary on this page) -------- */

  function manifestItem(file) {
    return el("li", {
      attrs: { style: MANIFEST_ITEM_STYLE },
      children: [
        el("span", { className: "mono", text: file.name }),
        file.secret ? el("span", { className: "pill pill-dim", text: "contains secrets" }) : null,
      ],
    });
  }

  const bundlePanel = el("section", {
    className: "panel setup-panel",
    attrs: { "aria-label": "Download backup" },
    children: [
      el("div", {
        className: "panel-head",
        children: [
          el("h3", { text: "Owner bundle" }),
          el("span", { className: "eyebrow", text: "harmony-owner-bundle.json" }),
        ],
      }),
      el("p", {
        className: "help",
        text: "One JSON bundle with every resource and setting — the restore point to take before larger changes, database imports, or network edits.",
      }),
      el("ul", {
        attrs: { style: MANIFEST_STYLE, "aria-label": "Files inside the bundle" },
        children: BUNDLE_FILES.map(manifestItem),
      }),
      notice("warn", "The bundle embeds mqtt-config.json and wpa_supplicant.conf, including the MQTT broker password and the Wi-Fi PSK. Treat the download as secret material — keep it off shared drives and out of pasted chats."),
      el("p", {
        className: "help",
        text: "The hub's /data flash is only 5 MiB: every import also writes an automatic timestamped copy under /data/codex/resource-backups, and older copies rotate out. Download a bundle before large imports instead of relying on device-side copies.",
      }),
      el("div", {
        className: "setup-actions",
        children: [
          el("a", { className: "btn btn-primary", attrs: { href: exportHref("bundle") }, text: "Download full backup" }),
        ],
      }),
    ],
  });

  /* -- Export: individual resources ------------------------------------- */

  function exportRow(resource, last) {
    return el("li", {
      attrs: { style: last ? ROW_NO_BORDER_STYLE : ROW_STYLE },
      children: [
        el("div", {
          children: [
            el("span", { className: "mono", text: resource.file }),
            el("span", {
              className: "mini muted",
              text: ` — ${resource.desc}${resource.secret ? " (secret)" : ""}`,
            }),
          ],
        }),
        el("a", {
          className: "btn btn-quiet btn-sm",
          attrs: { href: exportHref(resource.target) },
          text: "Download",
        }),
      ],
    });
  }

  const exportsPanel = el("section", {
    className: "panel setup-panel",
    attrs: { "aria-label": "Individual exports" },
    children: [
      el("div", { className: "panel-head", children: [el("h3", { text: "Individual exports" })] }),
      el("p", {
        className: "help",
        text: "Smaller downloads when you only want one part of the configuration — the same files the bundle contains.",
      }),
      el("ul", { children: RESOURCES.map((resource, index, arr) => exportRow(resource, index === arr.length - 1)) }),
    ],
  });

  /* -- Import ------------------------------------------------------------- */

  const targetSelect = el("select", {
    attrs: { id: "backupTarget", name: "target", "aria-describedby": "backupTargetHint" },
    children: [
      el("option", { attrs: { value: "bundle" }, text: "Full backup bundle" }),
      ...RESOURCES.map((r) =>
        el("option", { attrs: { value: r.target }, text: `${r.file} — ${r.desc}` })),
    ],
  });

  const targetHint = el("p", { className: "setup-field-hint", attrs: { id: "backupTargetHint" } });

  const payloadArea = el("textarea", {
    attrs: {
      id: "backupPayload",
      name: "payload",
      rows: "10",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "Backup contents",
    },
  });

  const fileInput = el("input", {
    attrs: {
      type: "file",
      id: "backupFile",
      accept: ".json,.conf,.txt,application/json,text/plain",
      style: "display:none",
    },
  });

  const readinessBox = el("div", {
    className: "setup-status",
    attrs: { id: "backupReadiness", role: "status", "aria-live": "polite" },
  });

  /* Last /api/config-ready answer: null until known, an Error if the probe
     failed (the hub still refuses unready restores itself). */
  let readyState = null;
  let readyTimer = null;
  let readyPolls = 0;        // polls since the last show or refusal (backoff)
  let shown = true;
  let busy = false;
  let override = false;      // "Restore without waiting" chosen
  let buttonMode = null;     // "idle" | "locked" | "busy": the label shown
  let readinessShown = null; // what readinessBox shows, so polls don't re-announce it
  let readinessToggle = null; // its "Restore without waiting" / "Wait" button

  const preflightBox = el("div", {
    className: "setup-status",
    attrs: { id: "backupPreflight", role: "status", "aria-live": "polite" },
  });

  const guardSlot = el("div", { className: "setup-actions" });

  const resultBox = el("div", {
    className: "setup-status",
    attrs: { id: "backupImportResult", role: "status", "aria-live": "polite" },
  });

  const importPanel = el("section", {
    className: "panel setup-panel",
    attrs: { "aria-label": "Restore from backup" },
    children: [
      el("div", { className: "panel-head", children: [el("h3", { text: "Restore from backup" })] }),
      el("p", {
        className: "help",
        text: "Paste what you downloaded — or load it from a file — choose its type, and restore. The hub validates the shape before writing and takes an automatic timestamped backup first. Wi-Fi restores are saved immediately but do not take effect until reboot.",
      }),
      el("label", { attrs: { for: "backupTarget" }, text: "Backup type" }),
      targetSelect,
      targetHint,
      el("label", { attrs: { for: "backupPayload" }, text: "Backup contents" }),
      payloadArea,
      el("div", {
        className: "setup-actions",
        children: [
          el("label", {
            className: "btn btn-quiet btn-sm",
            attrs: { for: "backupFile" },
            text: "Load from file…",
          }),
          fileInput,
        ],
      }),
      el("p", {
        className: "setup-field-hint",
        text: "Loading a file only puts its contents in the box above for review — nothing is uploaded until you confirm a restore.",
      }),
      readinessBox,
      preflightBox,
      guardSlot,
      resultBox,
    ],
  });

  /* -- Behavior ---------------------------------------------------------- */

  function renderTargetHint() {
    setText(targetHint, TARGET_HINTS[targetSelect.value] ?? "");
    payloadArea.placeholder = PLACEHOLDERS[targetSelect.value] ?? "";
  }

  function renderPreflight() {
    clear(preflightBox);
    const target = targetSelect.value;
    const payload = payloadArea.value;
    if (!payload.trim()) {
      preflightBox.appendChild(el("p", {
        className: "help",
        text: `Paste the ${IMPORT_LABELS[target]} contents above — the restore stays locked until the payload matches the selected type.`,
      }));
      return;
    }
    const check = preflightImport(target, payload);
    const kind = check.level === "error" ? "error" : check.level === "warn" ? "warn" : "ok";
    preflightBox.appendChild(notice(kind, check.message));
  }

  function renderResult(kind, message) {
    clear(resultBox);
    resultBox.appendChild(notice(kind, message));
  }

  function appendResultLine(text) {
    resultBox.appendChild(el("p", { className: "help", text }));
  }

  function readinessLock() {
    return importReadiness(targetSelect.value, readyState, { override });
  }

  function idleLabel() {
    return readinessLock().force ? "Restore without waiting" : "Restore backup";
  }

  /* The label changes only with the mode, so an armed guard's confirm label
     is never overwritten; disarm() puts the idle label back, so it runs
     before the locked label is set. */
  function applyButtonState() {
    if (!guardButton) return;
    const { locked } = readinessLock();
    guardButton.disabled = busy || locked;
    const mode = busy ? "busy" : locked ? "locked" : "idle";
    if (mode === buttonMode) return;
    if (mode === "locked" && guard) guard.disarm();
    setText(guardButton, mode === "busy" ? "Restoring…" : mode === "locked" ? "Waiting for the hub…" : idleLabel());
    buttonMode = mode;
  }

  function setOverride(value) {
    if (override === value) return;
    override = value;
    rebuildGuard(); // the guard's consequence and label depend on it
  }

  function renderReadiness() {
    const lock = readinessLock();
    // The hub became ready (or the target needs no wait): forget the choice.
    if (override && !lock.force) {
      setOverride(false);
      return;
    }
    const key = `${lock.message}|${lock.canOverride}|${lock.force}`;
    if (key !== readinessShown) {
      readinessShown = key;
      clear(readinessBox);
      readinessToggle = null;
      if (lock.message) readinessBox.appendChild(notice("warn", lock.message));
      if (lock.canOverride) {
        const toggle = el("button", {
          className: "btn btn-quiet btn-sm",
          attrs: { type: "button" },
          text: lock.force ? "Wait for the hub instead" : "Restore without waiting…",
        });
        toggle.addEventListener("click", () => {
          setOverride(!lock.force);
          readinessToggle?.focus(); // the box was rebuilt; keep keyboard focus on the toggle
        });
        readinessToggle = toggle;
        readinessBox.appendChild(el("div", { className: "setup-actions", children: [toggle] }));
      }
    }
    applyButtonState();
  }

  function stopReadyPolling() {
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
  }

  async function refreshReadiness() {
    stopReadyPolling();
    try {
      readyState = await getConfigReady();
    } catch (error) {
      readyState = error instanceof Error ? error : new Error(String(error));
    }
    if (!shown) return;
    renderReadiness();
    if (readyState && !(readyState instanceof Error) && !readyState.ready) {
      readyTimer = setTimeout(refreshReadiness, readyPollDelay(readyPolls++));
    }
  }

  function setBusy(isBusy) {
    busy = isBusy;
    applyButtonState();
  }

  async function verifyExport(target, gen) {
    const href = exportHref(target);
    try {
      const text = await getText(href);
      if (gen !== generation) return;
      appendResultLine(`Verified: ${href} now serves ${formatBytes(utf8ByteLength(text))}.`);
    } catch (error) {
      if (gen !== generation) return;
      appendResultLine(`Could not re-read ${href} to confirm (${error.message}); the hub reported success.`);
    }
  }

  async function runImport() {
    const target = targetSelect.value;
    const payload = payloadArea.value;
    const gen = ++generation;
    const check = preflightImport(target, payload);
    if (!check.valid) {
      renderResult("error", check.message);
      return;
    }
    const fields = readinessLock().force ? { target, payload, force: "1" } : { target, payload };
    renderResult("ok", `Sending ${formatBytes(check.requestBytes)} to the hub…`);
    setBusy(true);
    try {
      const reply = await postHubForm("/import", fields);
      if (gen !== generation) return;
      renderResult("ok", reply.msg || `${IMPORT_LABELS[target]} imported.`);
      await verifyExport(target, gen);
    } catch (error) {
      if (gen !== generation) return;
      renderResult("error", `Import failed: ${error.message}`);
      if (error && error.status === 503) {
        readyState = { ready: false, reason: "refused", message: error.message };
        readyPolls = 0;
        renderReadiness();
        refreshReadiness();
      }
    } finally {
      if (gen === generation) setBusy(false);
    }
  }

  /* dangerGuard attaches listeners to the button itself, so a target
     change gets a brand-new button — the old guard and its listeners are
     discarded with the node instead of accumulating. */
  function rebuildGuard() {
    if (guard) guard.disarm();
    clear(guardSlot);
    const target = targetSelect.value;
    const forcing = readinessLock().force;
    guardButton = el("button", {
      className: "btn btn-danger",
      attrs: { type: "button" },
      text: idleLabel(),
    });
    buttonMode = "idle";
    readinessShown = null;
    guardSlot.appendChild(guardButton);
    guard = dangerGuard(guardButton, {
      consequence: forcing ? `${FORCE_CONSEQUENCE} ${consequenceFor(target)}` : consequenceFor(target),
      confirmLabel: "Confirm restore",
      typedPhrase: target === "devices" ? DEVICES_PHRASE : target === "bundle" ? BUNDLE_PHRASE : undefined,
      onConfirm: runImport,
    });
    renderReadiness();
  }

  targetSelect.addEventListener("change", () => {
    renderTargetHint();
    renderPreflight();
    rebuildGuard();
  });
  payloadArea.addEventListener("input", renderPreflight);

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      payloadArea.value = String(reader.result ?? "");
      renderPreflight();
    };
    reader.onerror = () => renderResult("error", `Could not read ${file.name}.`);
    reader.readAsText(file);
  });

  section.appendChild(viewHead(
    "Backup",
    "Download a restore point before large edits, database imports, or network changes. Imports create an automatic timestamped backup first.",
  ));
  section.appendChild(bundlePanel);
  section.appendChild(exportsPanel);
  section.appendChild(importPanel);

  renderTargetHint();
  renderPreflight();
  rebuildGuard();
  refreshReadiness();

  return {
    onShow() {
      generation += 1;
      shown = true;
      readyPolls = 0;
      renderPreflight();
      refreshReadiness();
    },
    onHide() {
      generation += 1;
      shown = false;
      stopReadyPolling();
      if (guard) guard.disarm();
      if (override) setOverride(false);
    },
  };
}
