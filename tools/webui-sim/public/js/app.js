import * as hub from "./state.js";
import { createDashboardView } from "./views/dashboard.js";
import { createControlView } from "./views/control.js";
import { createActivitiesHomeView } from "./views/activities-home.js";
import { createActivitiesView } from "./views/activities.js";
import { createWizardView } from "./views/wizard.js";
import { createIrView } from "./views/ir.js";
import { createBluetoothView } from "./views/bluetooth.js";
import { createMqttView } from "./views/mqtt.js";
import { createWifiView } from "./views/wifi.js";
import { createBackupView } from "./views/backup.js";
import { createSystemView } from "./views/system.js";

const TITLES = {
  home: "Home",
  control: "Control",
  devices: "Devices",
  activities: "Activities",
  editor: "Advanced editor",
  wizard: "Activity setup",
  ir: "IR setup",
  bluetooth: "Bluetooth",
  mqtt: "MQTT",
  wifi: "Wi-Fi",
  backup: "Backup",
  system: "System",
};

const routes = {};

function register(route, sectionId, factory) {
  const section = document.getElementById(sectionId);
  routes[route] = { route, section, view: factory(section) };
}

register("home", "view-home", createDashboardView);
register("control", "view-control", createControlView);
register("activities", "view-activities-home", createActivitiesHomeView);
register("editor", "view-activities", createActivitiesView);
register("wizard", "view-wizard", createWizardView);
register("ir", "view-ir", createIrView);
register("bluetooth", "view-bluetooth", createBluetoothView);
register("mqtt", "view-mqtt", createMqttView);
register("wifi", "view-wifi", createWifiView);
register("backup", "view-backup", createBackupView);
register("system", "view-system", createSystemView);

/* Devices is the Control view in device mode (same handset, direct IR). */
routes.devices = { ...routes.control, route: "devices", params: { mode: "devices" } };

let current = null;

function routeFromHash() {
  const hash = location.hash.replace(/^#/, "");
  return routes[hash] ? hash : "control";
}

function show(route) {
  const next = routes[route];

  if (current && current.section !== next.section) {
    current.section.hidden = true;
    current.section.classList.remove("active");
    current.view.onHide?.();
  }

  if (current?.section !== next.section || next.section.hidden) {
    next.section.hidden = false;
    next.section.classList.add("active");
  }

  document.querySelectorAll(".nav-link").forEach((link) => {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  next.view.onShow?.(next.params);
  document.title = `${TITLES[route] ?? "Control"} · Harmony Hub Control`;
  current = next;
}

/* -- Top-bar live chip ------------------------------------------------- */

const liveChip = document.getElementById("topLiveChip");
const liveName = document.getElementById("topLiveName");

hub.subscribe((s) => {
  if (!liveChip || !liveName) return;
  if (s.currentId === "-1") {
    liveChip.hidden = false;
    liveChip.classList.remove("pill-live");
    liveChip.classList.add("pill-dim");
    liveChip.querySelector(".live-dot")?.remove();
    liveName.textContent = "Everything is off";
  } else if (s.currentId) {
    liveChip.hidden = false;
    liveChip.classList.add("pill-live");
    liveChip.classList.remove("pill-dim");
    if (!liveChip.querySelector(".live-dot")) {
      liveChip.insertAdjacentHTML("afterbegin", `<span class="live-dot" aria-hidden="true"></span>`);
    }
    const activity = hub.activityById(s.currentId);
    liveName.textContent = activity ? hub.activityName(activity) : `Activity ${s.currentId}`;
  } else {
    liveChip.hidden = true;
  }
});

/* -- Boot ---------------------------------------------------------------- */

window.addEventListener("hashchange", () => show(routeFromHash()));

if (!routes[location.hash.replace(/^#/, "")]) {
  history.replaceState(null, "", "#control");
}
show(routeFromHash());

hub.ensureConfig();
hub.refreshState();
