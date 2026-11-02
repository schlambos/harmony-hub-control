import * as hub from "./state.js";
import { icon } from "./ui/icons.js";
import { setAppBar } from "./ui/shell.js";
import { createRemoteView } from "./views/remote.js";
import { createActivitiesHomeView } from "./views/activities-home.js";
import { createActivitiesView } from "./views/activities.js";
import { createWizardView } from "./views/wizard.js";
import { createTouchScreenView } from "./views/touch-screen.js";
import { createDevicesView } from "./views/devices.js";
import { createSettingsView } from "./views/settings.js";
import { createBluetoothView } from "./views/bluetooth.js";
import { createRemotesView } from "./views/remotes.js";
import { createActivityButtonsView } from "./views/activity-buttons.js";
import { createMqttView } from "./views/mqtt.js";
import { createWifiView } from "./views/wifi.js";
import { createBackupView } from "./views/backup.js";
import { createSystemView } from "./views/system.js";

/* The app's four tabs. Sub-pages name their parent tab: they get the back
   arrow bar and keep that tab highlighted. */
const TABS = [
  { route: "remote", label: "Remote", icon: "settings_remote" },
  { route: "activities", label: "Activities", icon: "play_arrow" },
  { route: "devices", label: "Devices", icon: "tv" },
  { route: "settings", label: "Settings", icon: "settings" },
];

const ROUTES = {
  remote: { section: "view-remote", factory: createRemoteView, title: "Remote" },
  activities: { section: "view-activities-home", factory: createActivitiesHomeView, title: "Activities" },
  wizard: { parent: "activities", section: "view-wizard", factory: createWizardView, title: "Activity setup" },
  editor: { parent: "activities", section: "view-activities", factory: createActivitiesView, title: "Advanced editor" },
  touch: { parent: "activities", section: "view-touch", factory: createTouchScreenView, title: "On-screen buttons" },
  devices: { section: "view-devices", factory: createDevicesView, title: "Devices" },
  settings: { section: "view-settings", factory: createSettingsView, title: "Settings" },
  remotes: { parent: "settings", section: "view-remotes", factory: createRemotesView, title: "Remotes" },
  activitybuttons: { parent: "remotes", section: "view-activity-buttons", factory: createActivityButtonsView, title: "Activity buttons" },
  bluetooth: { parent: "settings", section: "view-bluetooth", factory: createBluetoothView, title: "Bluetooth" },
  mqtt: { parent: "settings", section: "view-mqtt", factory: createMqttView, title: "MQTT" },
  wifi: { parent: "settings", section: "view-wifi", factory: createWifiView, title: "Wi-Fi" },
  backup: { parent: "settings", section: "view-backup", factory: createBackupView, title: "Backup" },
  system: { parent: "settings", section: "view-system", factory: createSystemView, title: "System" },
};

/* Older hashes keep working: Home and Control became the Remote tab, and IR
   setup moved into the Devices tab. */
const ALIASES = { control: "remote", home: "remote", ir: "devices" };

const views = new Map();
let current = null;
let currentHash = "";

/* Each history entry the app shows carries its position, so a move can be
   taken back exactly when a view asks to stay (forward after Back, back
   after a link or a typed address). Rewriting an address keeps the entry's
   stamp. */
let position = 0;
let restoring = false;

function stampEntry() {
  const stamp = history.state?.melodiousPos;
  if (typeof stamp === "number") position = stamp;
  else {
    position += 1;
    history.replaceState({ ...(history.state ?? {}), melodiousPos: position }, "");
  }
}

function rewriteHash(hash) {
  history.replaceState(history.state, "", hash);
}

function viewFor(name) {
  if (!views.has(name)) {
    const route = ROUTES[name];
    const section = document.getElementById(route.section);
    views.set(name, { section, view: route.factory(section) });
  }
  return views.get(name);
}

/** "#devices/123" -> { name: "devices", args: ["123"] }; unknown -> remote. */
function parseHash() {
  const [head, ...args] = location.hash.replace(/^#/, "").split("/");
  const name = ALIASES[head] ?? head;
  return ROUTES[name] ? { name, args: args.filter(Boolean) } : null;
}

/* -- Navigation bar / rail ------------------------------------------------- */

function renderNav() {
  const nav = document.getElementById("nav");
  const favicon = document.querySelector("link[rel~='icon']")?.getAttribute("href") ?? "";
  nav.innerHTML = `
    <a class="nav-brand" href="#remote" aria-label="Melodious">
      ${favicon ? `<img src="${favicon}" alt="" width="40" height="40">` : ""}
      <span>Melodious</span>
    </a>
    ${TABS.map((t) => `<a class="nav-item" href="#${t.route}" data-tab="${t.route}">
        <span class="nav-pill">${icon(`${t.icon}_outlined`, { cls: "nav-icon-off" })}${icon(t.icon, { cls: "nav-icon-on" })}</span>
        <span class="nav-label">${t.label}</span>
      </a>`).join("")}`;
}

/* The tab a page sits under; sub-pages can nest (Remotes → Activity buttons). */
function tabOf(name) {
  let at = name;
  while (ROUTES[at]?.parent) at = ROUTES[at].parent;
  return at;
}

function markTab(tab) {
  document.querySelectorAll(".nav-item").forEach((link) => {
    if (link.dataset.tab === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

/* -- Routing ---------------------------------------------------------------- */

function show({ name, args }) {
  const route = ROUTES[name];
  const next = viewFor(name);
  if (current && current.section !== next.section) {
    current.section.hidden = true;
    current.section.classList.remove("active");
    current.view.onHide?.();
  }
  next.section.hidden = false;
  next.section.classList.add("active");
  // Every navigation starts at the top, also within one view (list → device).
  window.scrollTo(0, 0);
  markTab(tabOf(name));
  setAppBar(route.parent ? { title: route.title, back: route.parent } : null);
  document.body.dataset.route = name;
  next.view.onShow?.({ args });
  document.title = `${route.title} · Melodious`;
  current = next;
  currentHash = location.hash;
  stampEntry();
}

let asking = false;

async function route() {
  if (restoring) {
    // The move taken back below has landed on the view still on screen;
    // anything else routes as usual.
    restoring = false;
    if (location.hash === currentHash) return;
  }
  // A view with unsaved work (the wizard) may ask first. While it asks,
  // further moves wait, and the answer applies to wherever history is then.
  if (asking) return;
  if (current?.view.confirmLeave && location.hash !== currentHash) {
    asking = true;
    const leave = await current.view.confirmLeave();
    asking = false;
    if (!leave) {
      const stamp = history.state?.melodiousPos;
      const delta = position - (typeof stamp === "number" ? stamp : position + 1);
      if (delta) {
        restoring = true;
        history.go(delta);
      } else {
        rewriteHash(currentHash);
      }
      return;
    }
  }
  const parsed = parseHash();
  if (!parsed) {
    rewriteHash("#remote");
    show({ name: "remote", args: [] });
    return;
  }
  const head = location.hash.replace(/^#/, "").split("/")[0];
  if (ALIASES[head]) rewriteHash(`#${[parsed.name, ...parsed.args].join("/")}`);
  show(parsed);
}

/* -- Connection banner (the app's ConnectionBanner) -------------------------- */

const banner = document.getElementById("connBanner");

function renderBanner(s) {
  if (!banner) return;
  const lost = s.configLoaded && !s.configError && !s.reachable;
  banner.hidden = !lost;
  if (lost) {
    banner.innerHTML = `<button type="button" class="banner-btn">${icon("wifi_off", { size: 18 })}<span>Can't reach your hub · tap to retry</span></button>`;
  }
}

banner?.addEventListener("click", () => {
  hub.refreshState();
  hub.pollStateDigest();
});

hub.subscribe(renderBanner);

/* -- Boot ---------------------------------------------------------------------- */

renderNav();
window.addEventListener("hashchange", route);
route();

hub.ensureConfig();
hub.refreshState();
hub.startStatePolling();
