(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const text = (value) => String(value == null ? "" : value);
  const esc = (value) => text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const sameId = (a, b) => text(a) === text(b);
  const numericValue = (value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
  };
  const harmonyDate = () => `/Date(${Date.now()}+0000)/`;
  const objectId = (value) => text(value && (value["Id-"] ?? value.Id ?? value.id));
  const activityName = (activity) => text(
    activity && (activity.Name || activity.ActivityDisplayName || `Activity ${objectId(activity)}`)
  );
  const mapId = (map) => text(
    map && (map["ButtonMapId-"] ?? map.ButtonMapId ?? map["Id-"] ?? map.Id)
  );

  const ACTIVITY_TYPES = [
    { value: "1:1", type: 1, group: 1, label: "Watch TV" },
    { value: "2:2", type: 2, group: 2, label: "Watch a movie" },
    { value: "3:4", type: 3, group: 4, label: "Play a game" },
    { value: "4:3", type: 4, group: 3, label: "Listen to music" }
  ];

  const ROLE_TYPES = [
    ["DisplayActivityRole", "Display / picture"],
    ["VolumeActivityRole", "Volume control"],
    ["ChannelChangingActivityRole", "Channel control"],
    ["PlayMovieActivityRole", "Movie playback"],
    ["PlayGameActivityRole", "Game controls"],
    ["PlayMediaActivityRole", "Media playback"],
    ["KeyboardTextEntryActivityRole", "Keyboard / text entry"]
  ];

  const state = {
    config: null,
    revision: "",
    selectedId: "",
    selectedMap: 0,
    currentId: "",
    dirty: false,
    loading: false,
    idCursor: 10000000,
    knownIds: new Set(),
    commandCatalog: []
  };

  function activities() {
    const list = state.config && state.config.activityList && state.config.activityList.Activities;
    return Array.isArray(list) ? list : [];
  }

  function buttonMaps() {
    const list = state.config && state.config.mapList && state.config.mapList.ButtonMaps;
    return Array.isArray(list) ? list : [];
  }

  function deviceEntries() {
    if (!state.config || !state.config.deviceList) return [];
    const list = state.config.deviceList.DevicesWithFeatures || state.config.deviceList.Devices || [];
    return Array.isArray(list) ? list : [];
  }

  function devices() {
    return deviceEntries().map((entry) => {
      const device = entry.Device || entry;
      return {
        entry,
        raw: device,
        id: objectId(device),
        idValue: device["Id-"] ?? device.Id ?? device.id,
        name: text(device.Name || device.Label || objectId(device)),
        commands: Array.isArray(entry.Commands) ? entry.Commands : [],
        features: Array.isArray(entry.DeviceFeatures) ? entry.DeviceFeatures : []
      };
    }).filter((device) => device.id);
  }

  function selectedActivity() {
    return activities().find((activity) => sameId(objectId(activity), state.selectedId)) || null;
  }

  function activityMaps(activityId) {
    return buttonMaps().filter((map) => sameId(map && map["ActivityId-"], activityId));
  }

  function sortedActivities() {
    return activities().slice().sort((a, b) => {
      const ao = Number(a.ActivityOrder);
      const bo = Number(b.ActivityOrder);
      return (Number.isFinite(ao) ? ao : 9999) - (Number.isFinite(bo) ? bo : 9999) ||
        activityName(a).localeCompare(activityName(b));
    });
  }

  function activityTypeLabel(activity) {
    const match = ACTIVITY_TYPES.find((item) =>
      Number(activity && activity.Type) === item.type &&
      Number(activity && activity.ActivityGroup) === item.group
    );
    return match ? match.label : `Custom type ${text(activity && activity.Type) || "?"}`;
  }

  function markNotice(message, kind = "") {
    const box = byId("activityNotice");
    if (!box) return;
    box.textContent = message || "";
    box.className = `activity-notice${message ? " show" : ""}${kind ? ` ${kind}` : ""}`;
  }

  function setSaveState(message) {
    const box = byId("activitySaveState");
    if (box) box.textContent = message || "";
  }

  function setDirty(dirty = true) {
    state.dirty = dirty;
    const badge = byId("activityDirty");
    if (badge) badge.classList.toggle("show", dirty);
    setSaveState(dirty ? "Unsaved changes on this page" : "Hub resources match this editor");
  }

  function touch(activity) {
    if (activity && Object.prototype.hasOwnProperty.call(activity, "DateModified")) {
      activity.DateModified = harmonyDate();
    }
    setDirty(true);
  }

  function scanIds(value, key = "") {
    if (Array.isArray(value)) {
      value.forEach((item) => scanIds(item, key));
      return;
    }
    if (!value || typeof value !== "object") return;
    Object.entries(value).forEach(([childKey, child]) => {
      if ((childKey === "Id-" || childKey === "Id" || /^ButtonMapId-?$/.test(childKey)) &&
          (typeof child === "number" || /^\d+$/.test(text(child)))) {
        const number = Number(child);
        if (Number.isSafeInteger(number) && number >= 0 && number < 2147483000) {
          state.knownIds.add(text(number));
          state.idCursor = Math.max(state.idCursor, number + 1);
        }
      }
      scanIds(child, childKey);
    });
  }

  function resetIdPool() {
    state.knownIds = new Set();
    state.idCursor = 10000000;
    scanIds(state.config && state.config.activityList);
    scanIds(state.config && state.config.mapList);
  }

  function newId() {
    while (state.knownIds.has(text(state.idCursor))) state.idCursor += 1;
    const value = state.idCursor;
    state.knownIds.add(text(value));
    state.idCursor += 1;
    return value;
  }

  function normalizeOrders() {
    sortedActivities().forEach((activity, index) => {
      activity.ActivityOrder = index;
    });
  }

  function inputNamesForDevice(deviceId) {
    const device = devices().find((item) => sameId(item.id, deviceId));
    if (!device) return [];
    const names = [];
    const seen = new Set();
    const visit = (value) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value.Inputs)) {
        value.Inputs.forEach((input) => {
          const name = text(input && (input.InputName || input.Name));
          if (name && !seen.has(name)) {
            seen.add(name);
            names.push(name);
          }
        });
      }
      Object.values(value).forEach(visit);
    };
    device.features.forEach(visit);
    return names;
  }

  function buildCommandCatalog() {
    const catalog = [];
    devices().forEach((device) => {
      device.commands.forEach((command) => {
        const name = text(command && (command.Name || command.CommandName));
        if (!name) return;
        catalog.push({
          deviceId: device.id,
          deviceIdValue: device.idValue,
          deviceName: device.name,
          name,
          functionId: command["FunctionId-"] ?? command.FunctionId ?? command["Id-"] ?? command.Id ?? 0
        });
      });
    });
    state.commandCatalog = catalog;
  }

  function extractCurrentActivity(reply) {
    const raw = text(reply);
    let decoded = raw;
    for (let attempt = 0; attempt < 3 && typeof decoded === "string"; attempt += 1) {
      try {
        decoded = JSON.parse(decoded);
      } catch (_) {
        break;
      }
    }
    const find = (value, depth = 0) => {
      if (depth > 8 || value == null) return "";
      if (typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (/^(current)?activityid$/i.test(key) && /^-?\d+$/.test(text(child))) return text(child);
        }
        for (const [key, child] of Object.entries(value)) {
          if (/^result$/i.test(key) && /^-?\d+$/.test(text(child))) return text(child);
        }
        for (const child of Object.values(value)) {
          const found = find(child, depth + 1);
          if (found) return found;
        }
      } else if (typeof value === "string") {
        try {
          return find(JSON.parse(value), depth + 1);
        } catch (_) {
          return "";
        }
      }
      return "";
    };
    const structured = find(decoded);
    if (structured) return structured;
    const match = raw.match(/"(?:current)?activityId"\s*:\s*"?(-?\d+)"?/i) ||
      raw.match(/"result"\s*:\s*"?(-?\d+)"?/i);
    return match ? match[1] : "";
  }

  async function fetchJson(path, options) {
    const response = await fetch(path, options);
    const body = await response.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch (_) {
      throw new Error(body || `HTTP ${response.status}`);
    }
    if (!response.ok || json.ok === false) {
      const error = new Error(json.error || json.message || `HTTP ${response.status}`);
      error.response = json;
      error.status = response.status;
      throw error;
    }
    return json;
  }

  async function refreshCurrentState(quiet = false) {
    try {
      const result = await fetchJson("/api/activity-state");
      state.currentId = extractCurrentActivity(result.reply);
      renderCurrent();
      renderRoster();
      if (!quiet && !state.currentId) markNotice("The Hub answered, but its current activity could not be identified.", "warn");
    } catch (error) {
      state.currentId = "";
      renderCurrent();
      if (!quiet) markNotice(`Current activity unavailable: ${error.message}`, "error");
    }
  }

  async function loadActivities(options = {}) {
    if (state.loading) return;
    state.loading = true;
    markNotice("Loading native Harmony resources…");
    try {
      const config = await fetchJson("/api/activity-config");
      state.config = config;
      state.revision = text(config.revision);
      buildCommandCatalog();
      resetIdPool();
      const available = sortedActivities();
      if (!available.some((activity) => sameId(objectId(activity), state.selectedId))) {
        state.selectedId = available.length ? objectId(available[0]) : "";
      }
      state.selectedMap = 0;
      setDirty(false);
      renderAll();
      await refreshCurrentState(true);
      markNotice(options.afterSync
        ? "Harmony accepted the remote-sync request. The editor reloaded the Hub’s resulting resources."
        : `Loaded ${available.length} activities and ${buttonMaps().length} button maps.`);
    } catch (error) {
      state.config = null;
      renderAll();
      markNotice(`Could not load activity resources: ${error.message}`, "error");
    } finally {
      state.loading = false;
    }
  }

  function renderCurrent() {
    const title = byId("activityCurrentName");
    const meta = byId("activityCurrentMeta");
    const current = activities().find((activity) => sameId(objectId(activity), state.currentId));
    if (title) title.textContent = state.currentId === "-1"
      ? "Everything is off"
      : current
        ? activityName(current)
        : state.currentId
          ? `Activity ${state.currentId}`
          : "Waiting for Hub";
    if (meta) meta.textContent = state.currentId
      ? state.currentId === "-1"
        ? "PowerOff is active"
        : `${activityTypeLabel(current)} · activity ${state.currentId}`
      : "Current state has not been read yet";
  }

  function renderRoster() {
    const box = byId("activityList");
    if (!box) return;
    const rows = sortedActivities();
    if (!rows.length) {
      box.innerHTML = "<div class='activity-list-empty'>No activities are stored on this Hub.</div>";
      return;
    }
    box.innerHTML = rows.map((activity, index) => {
      const id = objectId(activity);
      const selected = sameId(id, state.selectedId);
      const running = sameId(id, state.currentId);
      return `
        <div class="activity-card${selected ? " selected" : ""}${running ? " running" : ""}">
          <button type="button" class="activity-card-main" data-activity-select="${esc(id)}">
            <strong class="activity-card-name">${esc(activityName(activity))}</strong>
            <span class="activity-card-meta">
              ${running ? "<span class='activity-live-dot'></span> Running" : esc(activityTypeLabel(activity))}
            </span>
          </button>
          <span class="activity-card-order">
            <button type="button" title="Run activity" aria-label="Run ${esc(activityName(activity))}" data-activity-run="${esc(id)}">▶</button>
            <button type="button" title="Move up" aria-label="Move ${esc(activityName(activity))} up" data-activity-move="${esc(id)}" data-direction="-1"${index === 0 ? " disabled" : ""}>↑</button>
            <button type="button" title="Move down" aria-label="Move ${esc(activityName(activity))} down" data-activity-move="${esc(id)}" data-direction="1"${index === rows.length - 1 ? " disabled" : ""}>↓</button>
          </span>
        </div>`;
    }).join("");
  }

  function renderTypeOptions(activity) {
    const current = `${Number(activity.Type)}:${Number(activity.ActivityGroup)}`;
    const known = ACTIVITY_TYPES.some((item) => item.value === current);
    return `${known ? "" : `<option value="${esc(current)}">Custom type ${esc(activity.Type)} / group ${esc(activity.ActivityGroup)}</option>`}${
      ACTIVITY_TYPES.map((item) =>
        `<option value="${item.value}"${item.value === current ? " selected" : ""}>${esc(item.label)}</option>`
      ).join("")
    }`;
  }

  function renderDeviceOptions(selected) {
    const known = devices().some((device) => sameId(device.id, selected));
    const preserved = selected && !known
      ? `<option value="${esc(selected)}" selected>Unavailable device ${esc(selected)} (saved)</option>`
      : "";
    return `<option value="">Choose a device</option>${preserved}${devices().map((device) =>
      `<option value="${esc(device.id)}"${sameId(device.id, selected) ? " selected" : ""}>${esc(device.name)}</option>`
    ).join("")}`;
  }

  function renderInputOptions(deviceId, selected) {
    const names = inputNamesForDevice(deviceId);
    const preserved = selected && !names.includes(selected)
      ? `<option value="${esc(selected)}" selected>${esc(selected)} (saved value)</option>`
      : "";
    return `<option value="">No input change</option>${preserved}${names.map((name) =>
      `<option value="${esc(name)}"${name === selected ? " selected" : ""}>${esc(name)}</option>`
    ).join("")}`;
  }

  function renderRoleTypeOptions(selected) {
    const known = ROLE_TYPES.some(([value]) => value === selected);
    return `${selected && !known ? `<option value="${esc(selected)}">${esc(selected)}</option>` : ""}${
      ROLE_TYPES.map(([value, label]) =>
        `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`
      ).join("")
    }`;
  }

  function renderRoles(activity) {
    const box = byId("activityRoleList");
    if (!box) return;
    if (!Array.isArray(activity.Roles)) activity.Roles = [];
    if (!activity.Roles.length) {
      box.innerHTML = "<div class='callout'><strong>No device roles yet.</strong>Add the display, volume, playback, and channel devices this activity should coordinate.</div>";
      return;
    }
    box.innerHTML = activity.Roles.map((role, index) => {
      const deviceId = text(role && role["DeviceId-"]);
      const selectedInput = text(role && role.SelectedInput && role.SelectedInput.Name);
      const delay = role.NextDevicePowerOnDelay == null ? "" : role.NextDevicePowerOnDelay;
      return `
        <div class="activity-role" data-role-index="${index}">
          <div>
            <label>Responsibility</label>
            <select data-role-field="type">${renderRoleTypeOptions(text(role.__type))}</select>
          </div>
          <div>
            <label>Device</label>
            <select data-role-field="device">${renderDeviceOptions(deviceId)}</select>
          </div>
          <button type="button" class="danger activity-role-remove" data-role-remove="${index}">Remove</button>
          <div>
            <label>Input selected on start</label>
            <select data-role-field="input">${renderInputOptions(deviceId, selectedInput)}</select>
          </div>
          <div>
            <label>Power on order</label>
            <input type="number" min="0" data-role-field="powerOn" value="${esc(role.PowerOnOrder ?? index)}">
          </div>
          <div>
            <label>Power off order</label>
            <input type="number" min="0" data-role-field="powerOff" value="${esc(role.PowerOffOrder ?? index)}">
          </div>
          <div>
            <label>Delay after power on (ms)</label>
            <input type="number" min="0" step="100" data-role-field="delay" value="${esc(delay)}" placeholder="Firmware default">
          </div>
        </div>`;
    }).join("");
  }

  function actionCatalogIndex(action) {
    if (!action || typeof action !== "object") return -1;
    return state.commandCatalog.findIndex((command) =>
      sameId(command.deviceId, action["DeviceId-"] ?? action.DeviceId) &&
      (
        (action.CommandName && command.name === action.CommandName) ||
        sameId(command.functionId, action["FunctionId-"] ?? action.FunctionId)
      )
    );
  }

  function commandLabel(command) {
    return `${command.deviceName} — ${command.name}`;
  }

  function actionValue(action) {
    if (!action || typeof action !== "object") return "";
    const selected = actionCatalogIndex(action);
    if (selected >= 0) return commandLabel(state.commandCatalog[selected]);
    return `Unavailable device ${text(action["DeviceId-"] ?? action.DeviceId)} — ${text(action.CommandName || "saved command")}`;
  }

  function renderCommandCatalog() {
    const list = byId("activityCommandCatalog");
    if (!list) return;
    list.innerHTML = state.commandCatalog.map((command) =>
      `<option value="${esc(commandLabel(command))}"></option>`
    ).join("");
  }

  function buttonLabel(button, index) {
    return text(
      button && (
        button.ButtonKey ||
        button.ButtonLabel ||
        button.ButtonName ||
        button.TouchButtonKey ||
        button.ButtonId
      )
    ) || `Button ${index + 1}`;
  }

  function mapLabel(map, index) {
    const surface = map && (map["SurfaceId-"] ?? map["ButtonMapSurfaceId-"] ?? map.SurfaceId);
    const type = text(map && map.__type).replace("ButtonMap", "") || "Surface";
    return `${type} ${surface == null ? index + 1 : surface}`;
  }

  function renderMappings(activity) {
    const maps = activityMaps(objectId(activity));
    const selector = byId("activityMapSelect");
    const list = byId("activityButtonList");
    const summary = byId("activityMapSummary");
    const clear = byId("activityClearMap");
    if (!selector || !list || !summary) return;
    renderCommandCatalog();
    if (state.selectedMap >= maps.length) state.selectedMap = 0;
    selector.innerHTML = maps.length
      ? maps.map((map, index) =>
        `<option value="${index}"${index === state.selectedMap ? " selected" : ""}>${esc(mapLabel(map, index))}</option>`
      ).join("")
      : "<option value='0'>No activity maps</option>";
    selector.disabled = maps.length === 0;
    if (clear) clear.disabled = maps.length === 0;
    if (!maps.length) {
      summary.textContent = "This activity has no remote-surface maps. Create or duplicate it from an existing activity to inherit the paired remote’s button surfaces.";
      list.innerHTML = "";
      return;
    }
    const map = maps[state.selectedMap];
    const buttons = Array.isArray(map.Buttons) ? map.Buttons : [];
    const assigned = buttons.filter((button) =>
      button && (button.ButtonAction || button.ButtonLongPressAction || button.ButtonDoublePressAction)
    ).length;
    summary.textContent = `${buttons.length} physical buttons · ${assigned} with at least one action · map ${mapId(map) || "unknown"}`;
    list.innerHTML = buttons.map((button, index) => `
      <div class="activity-button-row" data-button-index="${index}">
        <div class="activity-button-key">
          <strong>${esc(buttonLabel(button, index))}</strong>
          <span>ID ${esc(button.ButtonId ?? "—")}</span>
        </div>
        <div class="activity-action-field">
          <label>Press</label>
          <input list="activityCommandCatalog" data-action-field="ButtonAction" value="${esc(actionValue(button.ButtonAction))}" placeholder="Unassigned">
        </div>
        <div class="activity-action-field">
          <label>Long press</label>
          <input list="activityCommandCatalog" data-action-field="ButtonLongPressAction" value="${esc(actionValue(button.ButtonLongPressAction))}" placeholder="Unassigned">
        </div>
        <div class="activity-action-field">
          <label>Double press</label>
          <input list="activityCommandCatalog" data-action-field="ButtonDoublePressAction" value="${esc(actionValue(button.ButtonDoublePressAction))}" placeholder="Unassigned">
        </div>
      </div>`).join("");
  }

  function renderRaw(activity) {
    const rawActivity = byId("activityRawActivity");
    const rawMaps = byId("activityRawMaps");
    if (rawActivity) rawActivity.value = JSON.stringify(activity, null, 2);
    if (rawMaps) rawMaps.value = JSON.stringify(activityMaps(objectId(activity)), null, 2);
  }

  function renderEditor() {
    const activity = selectedActivity();
    const empty = byId("activityEmpty");
    const editor = byId("activityEditor");
    if (!empty || !editor) return;
    empty.classList.toggle("hidden", !!activity);
    editor.classList.toggle("hidden", !activity);
    if (!activity) return;

    byId("activityEditorTitle").textContent = activityName(activity);
    byId("activityEditorMeta").textContent = `Activity ${objectId(activity)} · order ${activity.ActivityOrder ?? "—"}`;
    byId("activityName").value = activityName(activity);
    byId("activityType").innerHTML = renderTypeOptions(activity);
    byId("activityIcon").value = text(activity.Icon);
    byId("activityDefaultChannel").value = text(activity.DefaultChannel);
    byId("activityDefaultStation").value = text(activity.DefaultStationName || activity.DefaultStation);
    renderRoles(activity);
    renderMappings(activity);
    renderRaw(activity);
    const badge = byId("activityDirty");
    if (badge) badge.classList.toggle("show", state.dirty);
  }

  function renderAll() {
    renderCurrent();
    renderRoster();
    renderEditor();
  }

  function selectActivity(id) {
    state.selectedId = text(id);
    state.selectedMap = 0;
    renderRoster();
    renderEditor();
  }

  function roleAt(index) {
    const activity = selectedActivity();
    return activity && Array.isArray(activity.Roles) ? activity.Roles[index] : null;
  }

  function setRoleField(index, field, value) {
    const activity = selectedActivity();
    const role = roleAt(index);
    if (!activity || !role) return;
    if (field === "type") role.__type = value;
    if (field === "device") {
      const device = devices().find((item) => sameId(item.id, value));
      role["DeviceId-"] = device ? device.idValue : numericValue(value);
      role.SelectedInput = null;
      touch(activity);
      renderRoles(activity);
      return;
    }
    if (field === "input") {
      role.SelectedInput = value
        ? { ChannelNumber: null, "Id-": newId(), Name: value }
        : null;
    }
    if (field === "powerOn") role.PowerOnOrder = Number(value) || 0;
    if (field === "powerOff") role.PowerOffOrder = Number(value) || 0;
    if (field === "delay") role.NextDevicePowerOnDelay = value === "" ? null : Math.max(0, Number(value) || 0);
    touch(activity);
  }

  function addRole() {
    const activity = selectedActivity();
    if (!activity) return;
    if (!Array.isArray(activity.Roles)) activity.Roles = [];
    const device = devices()[0];
    const order = activity.Roles.length;
    activity.Roles.push({
      SelectedInput: null,
      __type: "PlayMediaActivityRole",
      PowerOnOrder: order,
      "DeviceId-": device ? device.idValue : 0,
      NextDevicePowerOnDelay: null,
      "Id-": newId(),
      PowerOffOrder: order
    });
    touch(activity);
    renderRoles(activity);
  }

  function removeRole(index) {
    const activity = selectedActivity();
    if (!activity || !Array.isArray(activity.Roles)) return;
    activity.Roles.splice(index, 1);
    activity.Roles.forEach((role, nextIndex) => {
      role.PowerOnOrder = nextIndex;
      role.PowerOffOrder = nextIndex;
    });
    touch(activity);
    renderRoles(activity);
  }

  function createAction(index, previous, eventType) {
    const command = state.commandCatalog[index];
    if (!command) return previous || null;
    return Object.assign(
      previous && typeof previous === "object" ? clone(previous) : {},
      {
        "DeviceId-": command.deviceIdValue,
        __type: "ButtonCommandAction",
        "FunctionId-": command.functionId,
        Order: 0,
        CommandName: command.name,
        EventType: eventType,
        Id: previous && previous.Id != null ? previous.Id : 0
      }
    );
  }

  function setButtonAction(buttonIndex, field, value) {
    const activity = selectedActivity();
    if (!activity) return;
    const maps = activityMaps(objectId(activity));
    const map = maps[state.selectedMap];
    const button = map && Array.isArray(map.Buttons) ? map.Buttons[buttonIndex] : null;
    if (!button) return;
    if (value === "") button[field] = null;
    else {
      const commandIndex = state.commandCatalog.findIndex((command) => commandLabel(command) === value);
      if (commandIndex < 0) {
        markNotice("Choose a device command from the suggestion list, or clear the field to remove the action.", "warn");
        const activityNow = selectedActivity();
        if (activityNow) renderMappings(activityNow);
        return;
      }
      const eventType = field === "ButtonLongPressAction" ? 2 :
        field === "ButtonDoublePressAction" ? 3 : 1;
      button[field] = createAction(commandIndex, button[field], eventType);
    }
    touch(activity);
  }

  function clearSelectedMap() {
    const activity = selectedActivity();
    if (!activity) return;
    const map = activityMaps(objectId(activity))[state.selectedMap];
    if (!map || !Array.isArray(map.Buttons)) return;
    if (!window.confirm(`Clear every press, long-press, and double-press action from ${mapLabel(map, state.selectedMap)}?`)) return;
    map.Buttons.forEach((button) => {
      button.ButtonAction = null;
      button.ButtonLongPressAction = null;
      button.ButtonDoublePressAction = null;
    });
    touch(activity);
    renderMappings(activity);
  }

  function replaceIdentifier(value, oldActivityId, newActivityId, oldMapId, newMapId) {
    if (typeof value !== "string") return value;
    let next = value;
    if (oldActivityId) next = next.split(text(oldActivityId)).join(text(newActivityId));
    if (oldMapId) next = next.split(text(oldMapId)).join(text(newMapId));
    return next;
  }

  function cloneMapForActivity(sourceMap, oldActivityId, newActivityId, keepActions) {
    const map = clone(sourceMap);
    const oldMapId = mapId(map);
    const nextMapId = newId();
    map["ActivityId-"] = numericValue(newActivityId);
    if (Object.prototype.hasOwnProperty.call(map, "ButtonMapId-")) map["ButtonMapId-"] = nextMapId;
    if (Object.prototype.hasOwnProperty.call(map, "ButtonMapId")) map.ButtonMapId = nextMapId;
    if (Object.prototype.hasOwnProperty.call(map, "Id-") && !Object.prototype.hasOwnProperty.call(map, "ButtonMapId-")) {
      map["Id-"] = nextMapId;
    }
    if (Object.prototype.hasOwnProperty.call(map, "ButtonMapIdentifier")) {
      map.ButtonMapIdentifier = replaceIdentifier(
        map.ButtonMapIdentifier,
        oldActivityId,
        newActivityId,
        oldMapId,
        nextMapId
      );
    }
    if (Object.prototype.hasOwnProperty.call(map, "DateModified")) map.DateModified = harmonyDate();
    if (!keepActions && Array.isArray(map.Buttons)) {
      map.Buttons.forEach((button) => {
        button.ButtonAction = null;
        button.ButtonLongPressAction = null;
        button.ButtonDoublePressAction = null;
      });
      if (Array.isArray(map.Sequences)) map.Sequences = [];
    }
    return map;
  }

  function baselineActivity(source, id, keepSetup) {
    const now = harmonyDate();
    const activity = source ? clone(source) : {
      "AccountId-": 0,
      Alternatives: [],
      BaseImageUri: null,
      DefaultChannel: null,
      DefaultStation: null,
      DefaultStationName: null,
      EnterActions: [],
      ImageKey: null,
      IsDefault: false,
      IsMultiZone: false,
      IsTuningDefault: false,
      LeaveActions: [],
      StartScreen: null,
      State: 0,
      SuggestedDisplay: null,
      Zones: []
    };
    activity["Id-"] = numericValue(id);
    activity.Name = keepSetup ? `${activityName(source)} Copy` : "New Activity";
    activity.ActivityDisplayName = activity.Name;
    activity.ActivityOrder = activities().length;
    activity.ActivityGroup = keepSetup ? (activity.ActivityGroup ?? 1) : 1;
    activity.Type = keepSetup ? (activity.Type ?? 1) : 1;
    activity.DateCreated = now;
    activity.DateModified = now;
    activity.IsDefault = false;
    activity.State = 0;
    if (!keepSetup) {
      activity.Roles = [];
      activity.EnterActions = [];
      activity.LeaveActions = [];
      activity.Alternatives = [];
      activity.Zones = [];
      activity.Icon = null;
      activity.ImageKey = null;
      activity.DefaultChannel = null;
      activity.DefaultStation = null;
      activity.DefaultStationName = null;
    } else if (Array.isArray(activity.Roles)) {
      activity.Roles.forEach((role) => {
        role["Id-"] = newId();
        if (role.SelectedInput) role.SelectedInput["Id-"] = newId();
      });
    }
    return activity;
  }

  function createActivity(duplicate) {
    if (!state.config) return;
    const source = selectedActivity() || sortedActivities()[0] || null;
    const oldId = source ? objectId(source) : "";
    const id = newId();
    const activity = baselineActivity(source, id, duplicate);
    activities().push(activity);

    const sourceMaps = source ? activityMaps(oldId) : [];
    const templates = sourceMaps.length
      ? sourceMaps
      : buttonMaps().filter((map) => map && map["ActivityId-"] != null).slice(0, 2);
    templates.forEach((map) => {
      buttonMaps().push(cloneMapForActivity(map, map["ActivityId-"], id, duplicate));
    });
    normalizeOrders();
    state.selectedId = text(id);
    state.selectedMap = 0;
    touch(activity);
    renderAll();
    markNotice(duplicate
      ? "Duplicated the activity, its roles, and paired-remote button maps. Review the name and routing, then save."
      : "Created a blank activity using the paired remote’s surface templates. Add device roles and button actions, then save.");
    byId("activityName").focus();
    byId("activityName").select();
  }

  function deleteActivity() {
    const activity = selectedActivity();
    if (!activity) return;
    const id = objectId(activity);
    if (sameId(id, state.currentId)) {
      markNotice("This activity is currently running. Switch activities or power off before deleting it.", "warn");
      return;
    }
    if (!window.confirm(`Delete “${activityName(activity)}” and all of its remote button maps?`)) return;
    state.config.activityList.Activities = activities().filter((item) => !sameId(objectId(item), id));
    state.config.mapList.ButtonMaps = buttonMaps().filter((map) => !sameId(map && map["ActivityId-"], id));
    normalizeOrders();
    const next = sortedActivities()[0];
    state.selectedId = next ? objectId(next) : "";
    state.selectedMap = 0;
    setDirty(true);
    renderAll();
    markNotice("Activity removed from the working copy. Save to apply the deletion to the Hub.", "warn");
  }

  function moveActivity(id, direction) {
    const rows = sortedActivities();
    const index = rows.findIndex((activity) => sameId(objectId(activity), id));
    const target = index + Number(direction);
    if (index < 0 || target < 0 || target >= rows.length) return;
    const firstOrder = rows[index].ActivityOrder;
    rows[index].ActivityOrder = rows[target].ActivityOrder;
    rows[target].ActivityOrder = firstOrder;
    normalizeOrders();
    touch(rows[index]);
    renderRoster();
    renderEditor();
  }

  function validateGraph() {
    if (!state.config || !state.config.activityList || !state.config.mapList) {
      throw new Error("Activity resources are not loaded.");
    }
    if (!Array.isArray(state.config.activityList.Activities)) {
      throw new Error("ActivityList.Activities must be an array.");
    }
    if (!Array.isArray(state.config.mapList.ButtonMaps)) {
      throw new Error("MapList.ButtonMaps must be an array.");
    }
    const ids = new Set();
    const names = new Set();
    const mapIds = new Set();
    activities().forEach((activity) => {
      const id = objectId(activity);
      const name = activityName(activity).trim();
      if (!/^\d+$/.test(id)) throw new Error(`Activity “${name || "unnamed"}” has an invalid ID.`);
      if (ids.has(id)) throw new Error(`Activity ID ${id} is duplicated.`);
      if (!name) throw new Error(`Activity ${id} needs a name.`);
      if (names.has(name.toLowerCase())) throw new Error(`Activity name “${name}” is duplicated.`);
      ids.add(id);
      names.add(name.toLowerCase());
      if (!Array.isArray(activity.Roles)) throw new Error(`Activity “${name}” has an invalid Roles value.`);
      activity.Roles.forEach((role) => {
        const deviceId = text(role && role["DeviceId-"]);
        if (!deviceId) throw new Error(`Activity “${name}” has a role without a device ID.`);
      });
    });
    buttonMaps().forEach((map) => {
      const activityId = text(map && map["ActivityId-"]);
      if (activityId && activityId !== "-1" && !ids.has(activityId)) {
        throw new Error(`Button map ${mapId(map) || "unknown"} references missing activity ${activityId}.`);
      }
      const id = mapId(map);
      if (id && mapIds.has(id)) throw new Error(`Button map ID ${id} is duplicated.`);
      if (id) mapIds.add(id);
    });
    normalizeOrders();
  }

  async function saveActivities(syncRemote) {
    if (!state.config) return;
    try {
      validateGraph();
    } catch (error) {
      markNotice(error.message, "error");
      return;
    }
    const save = byId("activitySave");
    const saveSync = byId("activitySaveSync");
    if (save) save.disabled = true;
    if (saveSync) saveSync.disabled = true;
    markNotice(syncRemote
      ? "Saving through Harmony and submitting the paired-remote sync request…"
      : "Saving both activity resources through Harmony as one transaction…");
    try {
      const response = await fetch("/api/activity-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseRevision: state.revision,
          syncRemote: !!syncRemote,
          activityList: state.config.activityList,
          mapList: state.config.mapList
        })
      });
      const raw = await response.text();
      let result;
      try {
        result = JSON.parse(raw);
      } catch (_) {
        throw new Error(raw || `HTTP ${response.status}`);
      }
      if (result.saved) {
        state.revision = text(result.revision);
        setDirty(false);
      }
      if (!response.ok || result.ok === false) {
        const error = new Error(result.error || result.message || `HTTP ${response.status}`);
        error.status = response.status;
        error.response = result;
        throw error;
      }
      if (result.syncConflict) {
        markNotice(result.message, "warn");
        await loadActivities({ afterSync: true });
      } else {
        markNotice(result.message || "Activities saved.");
        await refreshCurrentState(true);
      }
    } catch (error) {
      if (error.status === 409 || (error.response && error.response.revision)) {
        markNotice("The Hub’s resources changed while this page was open. Reload before making another save.", "warn");
      } else if (error.response && error.response.saved) {
        markNotice(`${error.message} Your activity edits are saved locally; retry remote sync when ready.`, "warn");
      } else {
        markNotice(`Save failed: ${error.message}`, "error");
      }
    } finally {
      if (save) save.disabled = false;
      if (saveSync) saveSync.disabled = false;
    }
  }

  async function syncRemote() {
    if (state.dirty) {
      await saveActivities(true);
      return;
    }
    markNotice("Submitting Harmony’s paired-remote sync request…");
    try {
      await fetchJson("/api/activity-sync", { method: "POST" });
      await loadActivities({ afterSync: true });
    } catch (error) {
      markNotice(`Remote sync failed: ${error.message}`, "error");
    }
  }

  async function runActivity(id) {
    const activity = activities().find((item) => sameId(objectId(item), id));
    markNotice(id === "-1"
      ? "Powering off the current activity…"
      : `Starting ${activity ? activityName(activity) : `activity ${id}`}…`);
    try {
      await fetchJson("/api/activity-run", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ activityId: text(id) })
      });
      state.currentId = text(id);
      renderCurrent();
      renderRoster();
      markNotice(id === "-1"
        ? "Power-off command accepted by the Harmony engine."
        : `${activity ? activityName(activity) : "Activity"} was accepted by the Harmony engine.`);
      window.setTimeout(() => refreshCurrentState(true), 1400);
      window.setTimeout(() => refreshCurrentState(true), 4200);
    } catch (error) {
      markNotice(`Activity command failed: ${error.message}`, "error");
    }
  }

  function applyRawJson() {
    const current = selectedActivity();
    if (!current) return;
    let activityIndex = -1;
    let previousActivity = null;
    let previousMaps = null;
    try {
      const nextActivity = JSON.parse(byId("activityRawActivity").value);
      const nextMaps = JSON.parse(byId("activityRawMaps").value);
      if (!nextActivity || typeof nextActivity !== "object" || Array.isArray(nextActivity)) {
        throw new Error("Activity JSON must be an object.");
      }
      if (!Array.isArray(nextMaps)) throw new Error("Activity maps JSON must be an array.");
      if (!sameId(objectId(nextActivity), objectId(current))) {
        throw new Error("Advanced JSON cannot change the selected activity ID.");
      }
      nextMaps.forEach((map, index) => {
        if (!map || typeof map !== "object" || Array.isArray(map)) {
          throw new Error(`Button map ${index + 1} must be an object.`);
        }
        if (!sameId(map["ActivityId-"], state.selectedId)) {
          throw new Error(`Button map ${mapId(map) || index + 1} must reference activity ${state.selectedId}.`);
        }
      });
      activityIndex = activities().findIndex((item) => sameId(objectId(item), state.selectedId));
      previousActivity = state.config.activityList.Activities[activityIndex];
      previousMaps = state.config.mapList.ButtonMaps;
      state.config.activityList.Activities[activityIndex] = nextActivity;
      state.config.mapList.ButtonMaps = buttonMaps()
        .filter((map) => !sameId(map && map["ActivityId-"], state.selectedId))
        .concat(nextMaps);
      validateGraph();
      resetIdPool();
      touch(nextActivity);
      renderAll();
      markNotice("Advanced JSON applied to the working copy. Review it, then save.");
    } catch (error) {
      if (activityIndex >= 0 && previousActivity && previousMaps) {
        state.config.activityList.Activities[activityIndex] = previousActivity;
        state.config.mapList.ButtonMaps = previousMaps;
        resetIdPool();
      }
      markNotice(`Advanced JSON was not applied: ${error.message}`, "error");
    }
  }

  function showActivityTab(name) {
    document.querySelectorAll(".activity-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.activityTab === name);
    });
    document.querySelectorAll(".activity-tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.activityTabPanel === name);
    });
    if (name === "advanced") {
      const activity = selectedActivity();
      if (activity) renderRaw(activity);
    }
  }

  function bindUi() {
    document.querySelectorAll("[data-view-target='activities']").forEach((button) => {
      button.addEventListener("click", () => {
        if (!state.config) loadActivities();
      });
    });
    document.querySelectorAll(".activity-tab").forEach((tab) => {
      tab.addEventListener("click", () => showActivityTab(tab.dataset.activityTab));
    });

    byId("activityRefresh")?.addEventListener("click", () => {
      if (state.dirty && !window.confirm("Discard unsaved activity edits and reload from the Hub?")) return;
      loadActivities();
    });
    byId("activityRefreshState")?.addEventListener("click", () => refreshCurrentState());
    byId("activityPowerOff")?.addEventListener("click", () => runActivity("-1"));
    byId("activityNew")?.addEventListener("click", () => createActivity(false));
    byId("activitySync")?.addEventListener("click", syncRemote);
    byId("activityAddRole")?.addEventListener("click", addRole);
    byId("activityClearMap")?.addEventListener("click", clearSelectedMap);
    byId("activityApplyRaw")?.addEventListener("click", applyRawJson);
    byId("activitySave")?.addEventListener("click", () => saveActivities(false));
    byId("activitySaveSync")?.addEventListener("click", () => saveActivities(true));
    byId("activityDuplicate")?.addEventListener("click", () => createActivity(true));
    byId("activityDelete")?.addEventListener("click", deleteActivity);
    byId("activityRunSelected")?.addEventListener("click", () => {
      if (state.selectedId) runActivity(state.selectedId);
    });

    byId("activityList")?.addEventListener("click", (event) => {
      const select = event.target.closest("[data-activity-select]");
      const run = event.target.closest("[data-activity-run]");
      const move = event.target.closest("[data-activity-move]");
      if (select) selectActivity(select.dataset.activitySelect);
      if (run) runActivity(run.dataset.activityRun);
      if (move) moveActivity(move.dataset.activityMove, move.dataset.direction);
    });

    byId("activityName")?.addEventListener("input", (event) => {
      const activity = selectedActivity();
      if (!activity) return;
      activity.Name = event.target.value;
      activity.ActivityDisplayName = event.target.value;
      touch(activity);
      byId("activityEditorTitle").textContent = event.target.value || "Unnamed activity";
      renderRoster();
    });
    byId("activityType")?.addEventListener("change", (event) => {
      const activity = selectedActivity();
      if (!activity) return;
      const [type, group] = event.target.value.split(":").map(Number);
      activity.Type = type;
      activity.ActivityGroup = group;
      touch(activity);
      renderRoster();
    });
    byId("activityIcon")?.addEventListener("input", (event) => {
      const activity = selectedActivity();
      if (!activity) return;
      activity.Icon = event.target.value || null;
      touch(activity);
    });
    byId("activityDefaultChannel")?.addEventListener("input", (event) => {
      const activity = selectedActivity();
      if (!activity) return;
      activity.DefaultChannel = event.target.value || null;
      touch(activity);
    });
    byId("activityDefaultStation")?.addEventListener("input", (event) => {
      const activity = selectedActivity();
      if (!activity) return;
      activity.DefaultStationName = event.target.value || null;
      if (Object.prototype.hasOwnProperty.call(activity, "DefaultStation")) {
        activity.DefaultStation = event.target.value || null;
      }
      touch(activity);
    });

    byId("activityRoleList")?.addEventListener("change", (event) => {
      const field = event.target.dataset.roleField;
      const row = event.target.closest("[data-role-index]");
      if (field && row) setRoleField(Number(row.dataset.roleIndex), field, event.target.value);
    });
    byId("activityRoleList")?.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-role-remove]");
      if (remove) removeRole(Number(remove.dataset.roleRemove));
    });
    byId("activityMapSelect")?.addEventListener("change", (event) => {
      state.selectedMap = Number(event.target.value) || 0;
      const activity = selectedActivity();
      if (activity) renderMappings(activity);
    });
    byId("activityButtonList")?.addEventListener("change", (event) => {
      const field = event.target.dataset.actionField;
      const row = event.target.closest("[data-button-index]");
      if (field && row) setButtonAction(Number(row.dataset.buttonIndex), field, event.target.value);
    });

    window.addEventListener("beforeunload", (event) => {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  bindUi();
  if ((location.hash || "").replace(/^#/, "") === "activities" || byId("view-activities")?.classList.contains("active")) {
    loadActivities();
  }
})();
