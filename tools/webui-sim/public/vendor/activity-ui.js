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
  const positiveId = (value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
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

  // Highest map and button identities Logitech ever issued for this Hub. Offline
  // allocation starts above them so it can never reuse a cloud-issued value.
  const MAP_ID_FLOOR = 52944089;
  const BUTTON_ID_FLOOR = 1878029713;
  const ID_CEILING = 2147483000;
  const IDENTITY_KEYS = new Set([
    "Id",
    "Id-",
    "ButtonId",
    "ButtonMapId",
    "ButtonMapId-"
  ]);

  const state = {
    config: null,
    revision: "",
    selectedId: "",
    selectedMap: 0,
    currentId: "",
    dirty: false,
    loading: false,
    mapCursor: { next: MAP_ID_FLOOR + 1 },
    buttonCursor: { next: BUTTON_ID_FLOOR + 1 },
    knownIds: new Set(),
    commandCatalog: []
  };

  const ACTION_FIELDS = [
    "ButtonAction",
    "ButtonLongPressAction",
    "ButtonDoublePressAction"
  ];

  function activities() {
    const list = state.config && state.config.activityList && state.config.activityList.Activities;
    return Array.isArray(list) ? list : [];
  }

  function buttonMaps() {
    const list = state.config && state.config.mapList && state.config.mapList.ButtonMaps;
    return Array.isArray(list) ? list : [];
  }

  function functionMaps() {
    const list = state.config && state.config.functionList && state.config.functionList.FunctionMaps;
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

  function activityFunctionMaps(activityId) {
    return functionMaps().filter((map) =>
      text(map && map.__type).includes("ActivityFunctionMap") &&
      sameId(map && map["ActivityId-"], activityId)
    );
  }

  function deviceFunctionMap(deviceId) {
    return functionMaps().find((map) =>
      text(map && map.__type).includes("DeviceFunctionMap") &&
      sameId(map && map["DeviceId-"], deviceId)
    ) || null;
  }

  function deviceButtonMaps(deviceId) {
    return buttonMaps().filter((map) =>
      text(map && map.__type).includes("DeviceButtonMap") &&
      sameId(map && map["DeviceId-"], deviceId)
    );
  }

  function isKeyboardHidActivityMap(map) {
    return /^16420Activity-?\d+$/.test(text(map && map.ButtonMapIdentifier));
  }

  function isActivityButtonMap(map) {
    return text(map && map.__type).includes("ActivityButtonMap");
  }

  function isBluetoothKeyboardDevice(deviceId) {
    const device = devices().find((item) => sameId(item.id, deviceId));
    return !!device &&
      Number(device.raw && device.raw.Transport) === 32 &&
      device.raw.IsKeyboardAssociated !== false;
  }

  function ensureBluetoothKeyboardRoles() {
    const created = [];
    activities().forEach((activity) => {
      if (!Array.isArray(activity.Roles)) return;
      const existing = new Set(
        activity.Roles
          .filter((role) => text(role && role.__type).includes("KeyboardTextEntryActivityRole"))
          .map((role) => text(role && role["DeviceId-"]))
          .filter(Boolean)
      );
      const sources = new Map();
      activity.Roles.forEach((role) => {
        const type = text(role && role.__type);
        const deviceId = text(role && role["DeviceId-"]);
        if (!deviceId || type.includes("KeyboardTextEntryActivityRole") ||
            !isBluetoothKeyboardDevice(deviceId) || sources.has(deviceId)) {
          return;
        }
        sources.set(deviceId, role);
      });
      sources.forEach((source, deviceId) => {
        if (existing.has(deviceId)) return;
        const role = {
          "DeviceId-": source["DeviceId-"],
          __type: "KeyboardTextEntryActivityRole",
          PowerOffOrder: source.PowerOffOrder ?? 0,
          "Id-": newButtonId(),
          NextDevicePowerOnDelay: source.NextDevicePowerOnDelay ?? null,
          PowerOnOrder: source.PowerOnOrder ?? 0,
          SelectedInput: null
        };
        activity.Roles.push(role);
        existing.add(deviceId);
        created.push({ activity, role });
        activity.DateModified = harmonyDate();
      });
    });
    return created;
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

  function scanIds(value) {
    if (Array.isArray(value)) {
      value.forEach((item) => scanIds(item));
      return;
    }
    if (!value || typeof value !== "object") return;
    Object.entries(value).forEach(([childKey, child]) => {
      if (IDENTITY_KEYS.has(childKey) &&
          (typeof child === "number" || /^\d+$/.test(text(child)))) {
        const number = Number(child);
        if (Number.isSafeInteger(number) && number >= 0 && number < ID_CEILING) {
          state.knownIds.add(text(number));
          if (childKey === "ButtonId") {
            state.buttonCursor.next = Math.max(state.buttonCursor.next, number + 1);
          } else if (childKey === "ButtonMapId" || childKey === "ButtonMapId-") {
            state.mapCursor.next = Math.max(state.mapCursor.next, number + 1);
          }
        }
      }
      scanIds(child);
    });
  }

  function resetIdPool() {
    state.knownIds = new Set();
    state.mapCursor = { next: MAP_ID_FLOOR + 1 };
    state.buttonCursor = { next: BUTTON_ID_FLOOR + 1 };
    scanIds(state.config && state.config.activityList);
    scanIds(state.config && state.config.mapList);
    scanIds(state.config && state.config.functionList);
    scanIds(state.config && state.config.deviceList);
  }

  function allocateId(cursor, label) {
    let value = cursor.next;
    while (state.knownIds.has(text(value))) value += 1;
    if (value > ID_CEILING) {
      throw new Error(
        `No ${label} identity is available below ${ID_CEILING}; the Hub configuration is exhausted.`
      );
    }
    state.knownIds.add(text(value));
    cursor.next = value + 1;
    return value;
  }

  function newMapId() {
    return allocateId(state.mapCursor, "button map");
  }

  function newButtonId() {
    return allocateId(state.buttonCursor, "remote button");
  }

  function normalizeOrders() {
    sortedActivities().forEach((activity, index) => {
      activity.ActivityOrder = index;
    });
  }

  function activityMapRemotePrefix(map) {
    const match = text(map && map.ButtonMapIdentifier).match(/^(.+?)Activity-?\d+$/);
    return match ? match[1] : "";
  }

  function activityMapSurfaceKey(map) {
    if (!map || typeof map !== "object") return "";
    if (isKeyboardHidActivityMap(map)) return "virtual|16420|ActivityButtonMap";
    const prefix = activityMapRemotePrefix(map);
    if (prefix) return `${prefix}|${text(map.__type)}`;
    const surface = map["SurfaceId-"] ?? map.SurfaceId;
    const buttonSurface = map["ButtonMapSurfaceId-"] ?? map.ButtonMapSurfaceId;
    if (surface == null && buttonSurface == null) return "";
    return [
      map["RemoteId-"] ?? map.RemoteId,
      surface,
      buttonSurface,
      map.__type
    ].map(text).join("|");
  }

  function remoteSurfaceTemplate(prefix) {
    const maps = buttonMaps();
    const hasSurface = (map) =>
      map &&
      (map["SurfaceId-"] ?? map.SurfaceId ?? map["ButtonMapSurfaceId-"] ?? map.ButtonMapSurfaceId) != null;
    const pick = (predicate) => maps.find((map) => hasSurface(map) && predicate(map));
    const id = (map) => text(map && map.ButtonMapIdentifier);
    return (prefix && (
      pick((map) => text(map.__type).includes("ActivityButtonMap") && id(map).startsWith(`${prefix}Activity`)) ||
      pick((map) => id(map) === `${prefix}Root`) ||
      pick((map) => id(map).startsWith(prefix))
    )) ||
      pick((map) => text(map.__type).includes("ActivityButtonMap")) ||
      pick((map) => id(map).endsWith("Root")) ||
      pick(() => true) ||
      null;
  }

  function backfillMapSurfaceIds(map) {
    if (!map || typeof map !== "object") return false;
    const hasAll = ["ButtonMapSurfaceId-", "RemoteId-", "SurfaceId-"].every((key) => map[key] != null);
    if (hasAll) return false;
    const source = remoteSurfaceTemplate(activityMapRemotePrefix(map));
    if (!source) return false;
    let changed = false;
    [
      ["ButtonMapSurfaceId-", "ButtonMapSurfaceId"],
      ["RemoteId-", "RemoteId"],
      ["SurfaceId-", "SurfaceId"]
    ].forEach(([key, alias]) => {
      const value = source[key] ?? source[alias];
      if (map[key] == null && value != null) {
        map[key] = value;
        changed = true;
      }
    });
    return changed;
  }

  function isClientAction(action) {
    return text(action && action.__type).includes("ButtonClientAction");
  }

  // ButtonCommandAction and ButtonActivityAction always ship with Id 0, while a
  // ButtonClientAction carries a Hub-issued Id that must survive a clone.
  function resetActionIdentities(value) {
    if (Array.isArray(value)) {
      value.forEach(resetActionIdentities);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Object.prototype.hasOwnProperty.call(value, "Id") && !isClientAction(value)) {
      value.Id = 0;
    }
    Object.values(value).forEach(resetActionIdentities);
  }

  function prepareNewMapIdentities(map) {
    delete map.ButtonMapId;
    delete map["Id-"];
    delete map.Id;
    map["ButtonMapId-"] = newMapId();
    if (Array.isArray(map.Buttons)) {
      map.Buttons.forEach((button) => {
        if (!button || typeof button !== "object") return;
        button.ButtonId = newButtonId();
        button.ButtonState = 1;
        ACTION_FIELDS.forEach((field) => resetActionIdentities(button[field]));
      });
    }
    map.Sequences = [];
  }

  function hasButtonAction(button) {
    return ACTION_FIELDS.some((field) => {
      const action = button && button[field];
      return !!action && typeof action === "object";
    });
  }

  // A button with no action wedges the paired remote when it starts the activity.
  // Genuine Logitech maps vary in button count and only ever list buttons that act.
  function pruneActionlessButtons(map) {
    if (!map || !Array.isArray(map.Buttons)) return 0;
    const acting = map.Buttons.filter(hasButtonAction);
    const removed = map.Buttons.length - acting.length;
    if (removed > 0) map.Buttons = acting;
    return removed;
  }

  const FALLBACK_ACTIVITY_FUNCTION_GROUPS = new Set([
    "NumericBasic",
    "Volume",
    "Channel",
    "NavigationBasic",
    "TransportBasic",
    "TransportRecording",
    "TransportExtended",
    "NavigationDVD",
    "NavigationDSTB",
    "PictureAdjustment",
    "GameType1",
    "GameType3",
    "NavigationExtended",
    "DisplayMode",
    "Setup",
    "ColoredButtons",
    "PlayMode",
    "MediaCenter",
    "RadioTuner"
  ]);

  function roleDeviceId(activity, roleType) {
    const role = Array.isArray(activity && activity.Roles)
      ? activity.Roles.find((item) => text(item && item.__type).includes(roleType))
      : null;
    return text(role && role["DeviceId-"]);
  }

  function buttonIdentity(button) {
    return text(button && (
      button.ButtonKey ||
      button.TextOnRemote ||
      button.ButtonName ||
      button.ButtonLabel
    )).toLowerCase();
  }

  function sameRemoteSurface(left, right) {
    if (!left || !right) return false;
    const leftPrefix = activityMapRemotePrefix(left);
    const rightPrefix = activityMapRemotePrefix(right);
    if (leftPrefix && rightPrefix) return leftPrefix === rightPrefix;
    return sameId(left["RemoteId-"] ?? left.RemoteId, right["RemoteId-"] ?? right.RemoteId) &&
      sameId(left["SurfaceId-"] ?? left.SurfaceId, right["SurfaceId-"] ?? right.SurfaceId) &&
      sameId(
        left["ButtonMapSurfaceId-"] ?? left.ButtonMapSurfaceId,
        right["ButtonMapSurfaceId-"] ?? right.ButtonMapSurfaceId
      );
  }

  function preferredButtonDeviceId(activity, identity) {
    if (/^(volumeup|volumedown|volumemute|mute)$/.test(identity)) {
      return roleDeviceId(activity, "VolumeActivityRole");
    }
    if (/^(channelup|channeldown|number[0-9]|[0-9])$/.test(identity)) {
      const channelDevice = roleDeviceId(activity, "ChannelChangingActivityRole");
      if (channelDevice) return channelDevice;
    }
    return roleDeviceId(activity, "PlayGameActivityRole") ||
      roleDeviceId(activity, "PlayMovieActivityRole") ||
      roleDeviceId(activity, "PlayMediaActivityRole") ||
      roleDeviceId(activity, "ChannelChangingActivityRole") ||
      roleDeviceId(activity, "KeyboardTextEntryActivityRole") ||
      roleDeviceId(activity, "DisplayActivityRole");
  }

  function isSequenceAction(action) {
    return text(action && action.__type).includes("ButtonSequenceAction");
  }

  function findSequence(map, sequenceId) {
    const list = map && Array.isArray(map.Sequences) ? map.Sequences : [];
    return list.find((sequence) =>
      sequence && sequence.SequenceId != null && sameId(sequence.SequenceId, sequenceId)
    ) || null;
  }

  function resolvesInMap(map, action) {
    return !isSequenceAction(action) || !!findSequence(map, action.SequenceId);
  }

  // Sequences are per map: the stock engine looks a ButtonSequenceAction up in
  // its own map's Sequences only and drops the button when it isn't there, and
  // the Hub refuses to save the map (#201). An action copied into another map
  // takes its sequence along. Returns false when the source has none to give.
  function carrySequence(sourceMap, targetMap, action) {
    if (resolvesInMap(targetMap, action)) return true;
    const sequence = findSequence(sourceMap, action.SequenceId);
    if (!sequence) return false;
    if (!Array.isArray(targetMap.Sequences)) targetMap.Sequences = [];
    targetMap.Sequences.push(clone(sequence));
    return true;
  }

  function findMappedButton(maps, targetMap, targetButton, field) {
    const identity = buttonIdentity(targetButton);
    if (!identity) return null;
    const ranked = maps.slice().sort((left, right) =>
      Number(sameRemoteSurface(right, targetMap)) -
      Number(sameRemoteSurface(left, targetMap))
    );
    for (const map of ranked) {
      const match = (Array.isArray(map.Buttons) ? map.Buttons : []).find((button) =>
        buttonIdentity(button) === identity &&
        button &&
        button[field] &&
        typeof button[field] === "object" &&
        resolvesInMap(map, button[field])
      );
      if (match) return { action: match[field], map };
    }
    return null;
  }

  // A sequence press whose sequence isn't in its own map (or a sibling map of
  // the same activity or device to copy it from) does nothing on the Hub, but
  // blocks every save. Such data comes from outside the editor, so clear it
  // and say which button lost it rather than leave the user unable to save.
  function repairDanglingSequenceActions() {
    const cleared = [];
    let carried = 0;
    buttonMaps().forEach((map) => {
      if (!map || !Array.isArray(map.Buttons)) return;
      const activityId = text(map["ActivityId-"]);
      const deviceId = text(map["DeviceId-"]);
      const siblings = buttonMaps().filter((candidate) =>
        candidate !== map && candidate && (
          (activityId && sameId(candidate["ActivityId-"], activityId)) ||
          (deviceId && sameId(candidate["DeviceId-"], deviceId))
        )
      );
      let mapChanged = false;
      map.Buttons.forEach((button) => {
        ACTION_FIELDS.forEach((field) => {
          const action = button && button[field];
          if (!action || typeof action !== "object" || resolvesInMap(map, action)) return;
          const source = siblings.find((candidate) => findSequence(candidate, action.SequenceId));
          if (source && carrySequence(source, map, action)) {
            carried += 1;
          } else {
            cleared.push({
              map: text(map.ButtonMapIdentifier || map["ButtonMapId-"] || "unknown"),
              button: buttonIdentity(button) || text(button && button.ButtonId),
              field,
              sequenceId: text(action.SequenceId)
            });
            button[field] = null;
          }
          mapChanged = true;
        });
      });
      if (mapChanged && Object.prototype.hasOwnProperty.call(map, "DateModified")) {
        map.DateModified = harmonyDate();
      }
    });
    return { cleared, carried };
  }

  function backfillActivityButtonMaps(activity) {
    const activityId = objectId(activity);
    const maps = activityMaps(activityId).filter((map) => !isKeyboardHidActivityMap(map));
    let changes = 0;
    maps.forEach((map) => {
      (Array.isArray(map.Buttons) ? map.Buttons : []).forEach((button) => {
        const identity = buttonIdentity(button);
        if (!identity) return;
        const siblingMaps = maps.filter((candidate) => candidate !== map);
        const deviceId = preferredButtonDeviceId(activity, identity);
        const sourceDeviceMaps = deviceId ? deviceButtonMaps(deviceId) : [];
        ACTION_FIELDS.forEach((field) => {
          if (button[field] && typeof button[field] === "object") return;
          const found =
            findMappedButton(siblingMaps, map, button, field) ||
            findMappedButton(sourceDeviceMaps, map, button, field);
          if (!found) return;
          const action = clone(found.action);
          resetActionIdentities(action);
          if (!carrySequence(found.map, map, action)) return;
          button[field] = action;
          changes += 1;
        });
      });
      if (changes > 0 && Object.prototype.hasOwnProperty.call(map, "DateModified")) {
        map.DateModified = harmonyDate();
      }
    });
    return changes;
  }

  const HID_DIRECT_COMMANDS = new Set([
    "Back", "DirectionDown", "DirectionLeft", "DirectionRight", "DirectionUp",
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    "FastForward", "Info", "Menu", "Pause", "Play", "Rewind", "Stop",
    "VolumeDown", "VolumeUp"
  ]);

  function hidButtonKey(commandName) {
    const name = text(commandName);
    if (/^[0-9]$/.test(name)) return `Number${name}`;
    if (name === "Mute") return "VolumeMute";
    if (name === "Select") return "Enter";
    return HID_DIRECT_COMMANDS.has(name) ? name : "";
  }

  function createCommandAction(device, command) {
    return {
      "DeviceId-": device.idValue,
      __type: "ButtonCommandAction",
      "FunctionId-": command["FunctionId-"] ?? command.FunctionId ?? command["Id-"] ?? command.Id ?? 0,
      Order: 0,
      CommandName: text(command.Name || command.CommandName),
      EventType: 1,
      Id: 0
    };
  }

  function composeKeyboardHidMap(activity, deviceId) {
    const device = devices().find((item) => sameId(item.id, deviceId));
    if (!device) return null;
    const source = activityMaps(objectId(activity)).find((map) =>
      !isKeyboardHidActivityMap(map) &&
      /^16414Activity/.test(text(map && map.ButtonMapIdentifier))
    ) || activityMaps(objectId(activity)).find((map) => !isKeyboardHidActivityMap(map));
    if (!source) return null;
    const buttons = [];
    const seen = new Set();
    device.commands.forEach((command) => {
      const commandName = text(command && (command.Name || command.CommandName));
      const key = hidButtonKey(commandName);
      if (!key || seen.has(key.toLowerCase())) return;
      seen.add(key.toLowerCase());
      buttons.push({
        ButtonId: newButtonId(),
        __type: "HardRemoteButton",
        ButtonAction: createCommandAction(device, command),
        ButtonDoublePressAction: null,
        FunctionGroupType: /^Number[0-9]$/.test(key) ? 2 : 0,
        ButtonState: 1,
        ButtonKey: key,
        ButtonLongPressAction: null
      });
    });
    const fallbackSurface = remoteSurfaceTemplate("16414") || {};
    const map = {
      "ButtonMapId-": newMapId(),
      "ActivityId-": numericValue(objectId(activity)),
      Buttons: buttons,
      "ButtonMapSurfaceId-": source["ButtonMapSurfaceId-"] ?? source.ButtonMapSurfaceId ?? fallbackSurface["ButtonMapSurfaceId-"] ?? fallbackSurface.ButtonMapSurfaceId ?? null,
      "RemoteId-": source["RemoteId-"] ?? source.RemoteId ?? fallbackSurface["RemoteId-"] ?? fallbackSurface.RemoteId ?? null,
      __type: "ActivityButtonMap",
      ButtonMapIdentifier: `16420Activity${objectId(activity)}`,
      DateModified: harmonyDate(),
      Sequences: [],
      "SurfaceId-": source["SurfaceId-"] ?? source.SurfaceId ?? fallbackSurface["SurfaceId-"] ?? fallbackSurface.SurfaceId ?? null
    };
    pruneActionlessButtons(map);
    return map;
  }

  function activityFunctionGroupNames() {
    const names = new Set();
    functionMaps().forEach((map) => {
      if (!text(map && map.__type).includes("ActivityFunctionMap")) return;
      (Array.isArray(map.FunctionGroups) ? map.FunctionGroups : []).forEach((group) => {
        const name = text(group && group.Name);
        if (name) names.add(name);
      });
    });
    return names.size ? names : FALLBACK_ACTIVITY_FUNCTION_GROUPS;
  }

  function composeActivityFunctionMap(activity) {
    const activityId = objectId(activity);
    const supportedGroups = activityFunctionGroupNames();
    const groups = new Map();
    const playDevice =
      roleDeviceId(activity, "PlayGameActivityRole") ||
      roleDeviceId(activity, "PlayMovieActivityRole") ||
      roleDeviceId(activity, "PlayMediaActivityRole") ||
      roleDeviceId(activity, "ChannelChangingActivityRole") ||
      roleDeviceId(activity, "KeyboardTextEntryActivityRole") ||
      roleDeviceId(activity, "DisplayActivityRole");
    const volumeDevice = roleDeviceId(activity, "VolumeActivityRole");
    const channelDevice = roleDeviceId(activity, "ChannelChangingActivityRole");
    const displayDevice = roleDeviceId(activity, "DisplayActivityRole");

    const addGroups = (deviceId, accepted, overwrite = false) => {
      const map = deviceFunctionMap(deviceId);
      const sourceGroups = map && Array.isArray(map.FunctionGroups) ? map.FunctionGroups : [];
      sourceGroups.forEach((group) => {
        const name = text(group && group.Name);
        if (!name || !supportedGroups.has(name) || !accepted(name)) return;
        if (overwrite || !groups.has(name)) groups.set(name, clone(group));
      });
    };

    if (playDevice) {
      addGroups(playDevice, (name) =>
        name !== "Power" &&
        name !== "Miscellaneous" &&
        name !== "Volume" &&
        name !== "DisplayMode" &&
        name !== "PictureAdjustment" &&
        (name !== "Channel" || !!channelDevice)
      );
    }
    if (channelDevice) {
      addGroups(
        channelDevice,
        (name) => name === "NumericBasic" || name === "Channel",
        true
      );
    }
    if (volumeDevice) {
      addGroups(volumeDevice, (name) => name === "Volume", true);
    }
    if (displayDevice) {
      addGroups(
        displayDevice,
        (name) => name === "DisplayMode" || name === "PictureAdjustment",
        true
      );
    }

    return {
      UIModeName: `Functions.UserConfigurator.${activityId}`,
      __type: "ActivityFunctionMap",
      "ActivityId-": numericValue(activityId),
      FunctionGroups: [...groups.values()]
    };
  }

  function replaceActivityFunctionMap(activity, nextMap = null) {
    if (!state.config || !state.config.functionList) return;
    const id = objectId(activity);
    const maps = functionMaps();
    const index = maps.findIndex((map) =>
      text(map && map.__type).includes("ActivityFunctionMap") &&
      sameId(map && map["ActivityId-"], id)
    );
    const replacement = nextMap || composeActivityFunctionMap(activity);
    if (index >= 0) maps.splice(index, 1, replacement);
    else maps.push(replacement);
  }

  function cloneFunctionMapForActivity(sourceMap, oldActivityId, newActivityId) {
    const map = clone(sourceMap);
    map["ActivityId-"] = numericValue(newActivityId);
    map.__type = "ActivityFunctionMap";
    map.UIModeName = replaceIdentifier(
      text(map.UIModeName || `Functions.UserConfigurator.${oldActivityId}`),
      oldActivityId,
      newActivityId,
      "",
      ""
    );
    return map;
  }

  function clearOrphanedActivityActions(validActivityIds = null) {
    const ids = validActivityIds || new Set(
      activities().map((activity) => objectId(activity)).filter(Boolean)
    );
    const cleared = [];
    buttonMaps().forEach((map) => {
      let mapChanged = false;
      if (!map || !Array.isArray(map.Buttons)) return;
      map.Buttons.forEach((button) => {
        ACTION_FIELDS.forEach((field) => {
          const action = button && button[field];
          const activityId = text(action && action["ActivityId-"]);
          if (!activityId || activityId === "-1" || ids.has(activityId)) return;
          cleared.push({
            map,
            button,
            field,
            activityId
          });
          button[field] = null;
          mapChanged = true;
        });
      });
      if (mapChanged && Object.prototype.hasOwnProperty.call(map, "DateModified")) {
        map.DateModified = harmonyDate();
      }
    });
    return cleared;
  }

  // A persisted map without a ButtonMapId-, or a button with ButtonId 0 or
  // ButtonState 0, stops the paired remote from transmitting.
  function repairActivityMapIdentities() {
    const repair = {
      repairedMaps: 0,
      allocatedMapIds: 0,
      allocatedButtonIds: 0,
      correctedButtonStates: 0
    };
    buttonMaps().forEach((map) => {
      if (!isActivityButtonMap(map)) return;
      let changed = false;
      const legacyMapId = positiveId(map.ButtonMapId);
      if (legacyMapId && !positiveId(map["ButtonMapId-"])) {
        map["ButtonMapId-"] = legacyMapId;
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(map, "ButtonMapId")) {
        delete map.ButtonMapId;
        changed = true;
      }
      if (!positiveId(map["ButtonMapId-"])) {
        map["ButtonMapId-"] = newMapId();
        repair.allocatedMapIds += 1;
        changed = true;
      }
      if (!Array.isArray(map.Sequences)) {
        map.Sequences = [];
        changed = true;
      }
      (Array.isArray(map.Buttons) ? map.Buttons : []).forEach((button) => {
        if (!button || typeof button !== "object") return;
        if (!positiveId(button.ButtonId)) {
          button.ButtonId = newButtonId();
          repair.allocatedButtonIds += 1;
          changed = true;
        }
        if (Number(button.ButtonState) !== 1) {
          button.ButtonState = 1;
          repair.correctedButtonStates += 1;
          changed = true;
        }
      });
      if (!changed) return;
      repair.repairedMaps += 1;
      if (Object.prototype.hasOwnProperty.call(map, "DateModified")) {
        map.DateModified = harmonyDate();
      }
    });
    return repair;
  }

  // Scoped to ActivityButtonMap: the live 16414Root legitimately carries action-less
  // shortcut buttons, and pruning those would break activity selection and PowerOff.
  function pruneActionlessActivityButtons() {
    let removed = 0;
    buttonMaps().forEach((map) => {
      if (!isActivityButtonMap(map)) return;
      const pruned = pruneActionlessButtons(map);
      if (!pruned) return;
      removed += pruned;
      if (Object.prototype.hasOwnProperty.call(map, "DateModified")) {
        map.DateModified = harmonyDate();
      }
    });
    return removed;
  }

  function reconcileActivityMaps() {
    if (!state.config || !state.config.activityList || !state.config.mapList ||
        !state.config.functionList ||
        !Array.isArray(state.config.activityList.Activities) ||
        !Array.isArray(state.config.mapList.ButtonMaps) ||
        !Array.isArray(state.config.functionList.FunctionMaps)) {
      return {
        changed: false,
        removed: [],
        created: [],
        removedFunctions: [],
        createdFunctions: [],
        clearedActivityActions: [],
        repairedIdentifiers: [],
        createdKeyboardRoles: [],
        routedButtonActions: 0,
        createdKeyboardHidMaps: [],
        removedKeyboardHidMaps: [],
        repairedMapIdentities: 0,
        allocatedMapIds: 0,
        allocatedButtonIds: 0,
        correctedButtonStates: 0,
        prunedActionlessButtons: 0,
        clearedSequenceActions: [],
        carriedSequences: 0
      };
    }
    const ids = new Set(activities().map((activity) => objectId(activity)).filter(Boolean));
    const currentDeviceIds = new Set(devices().map((device) => device.id));
    const createdKeyboardRoles = ensureBluetoothKeyboardRoles();
    const keyboardDevicesByActivity = new Map(activities().map((activity) => [
      objectId(activity),
      new Set((Array.isArray(activity.Roles) ? activity.Roles : [])
        .filter((role) => text(role && role.__type).includes("KeyboardTextEntryActivityRole"))
        .map((role) => text(role && role["DeviceId-"]))
        .filter(Boolean))
    ]));
    const originalMaps = buttonMaps().slice();
    const templates = new Map();
    originalMaps.forEach((map) => {
      const activityId = text(map && map["ActivityId-"]);
      if (!activityId || activityId === "-1" || isKeyboardHidActivityMap(map)) return;
      const key = activityMapSurfaceKey(map);
      if (!key) return;
      const current = templates.get(key);
      if (!current || (ids.has(activityId) && !ids.has(text(current["ActivityId-"])))) {
        templates.set(key, map);
      }
    });

    const removed = originalMaps.filter((map) => {
      const activityId = text(map && map["ActivityId-"]);
      const deviceId = text(map && map["DeviceId-"]);
      return (
        (activityId && activityId !== "-1" && !ids.has(activityId)) ||
        (deviceId && !currentDeviceIds.has(deviceId)) ||
        (isKeyboardHidActivityMap(map) &&
          !(keyboardDevicesByActivity.get(activityId)?.size > 0))
      );
    });
    const removedKeyboardHidMaps = removed.filter(isKeyboardHidActivityMap);
    state.config.mapList.ButtonMaps = originalMaps.filter((map) => !removed.includes(map));
    const clearedActivityActions = clearOrphanedActivityActions(ids);
    const repairedIdentifiers = [];
    buttonMaps().forEach((map) => {
      const activityId = text(map && map["ActivityId-"]);
      if (!activityId || activityId === "-1" || !ids.has(activityId)) return;
      const normalized = normalizeActivityMapIdentifiers(map, activityId);
      const backfilled = backfillMapSurfaceIds(map);
      if (!normalized && !backfilled) return;
      if (Object.prototype.hasOwnProperty.call(map, "DateModified")) {
        map.DateModified = harmonyDate();
      }
      repairedIdentifiers.push(map);
    });

    const created = [];
    activities().forEach((activity) => {
      const activityId = objectId(activity);
      const existing = new Set(
        activityMaps(activityId).map(activityMapSurfaceKey).filter(Boolean)
      );
      templates.forEach((template, key) => {
        if (existing.has(key)) return;
        const map = cloneMapForActivity(
          template,
          template["ActivityId-"],
          activityId,
          false
        );
        state.config.mapList.ButtonMaps.push(map);
        created.push(map);
        existing.add(key);
      });
    });

    let routedButtonActions = 0;
    activities().forEach((activity) => {
      routedButtonActions += backfillActivityButtonMaps(activity);
    });

    const createdKeyboardHidMaps = [];
    activities().forEach((activity) => {
      const activityId = objectId(activity);
      const keyboardDevices = keyboardDevicesByActivity.get(activityId) || new Set();
      if (!keyboardDevices.size) return;
      const existing = activityMaps(activityId).find(isKeyboardHidActivityMap);
      if (existing) return;
      const map = composeKeyboardHidMap(activity, [...keyboardDevices][0]);
      if (!map) return;
      state.config.mapList.ButtonMaps.push(map);
      createdKeyboardHidMaps.push(map);
    });

    const sequenceRepair = repairDanglingSequenceActions();
    const prunedActionlessButtons = pruneActionlessActivityButtons();
    const identityRepair = repairActivityMapIdentities();

    const originalFunctions = functionMaps().slice();
    const seenActivityFunctions = new Set();
    const removedFunctions = originalFunctions.filter((map) => {
      const mapType = text(map && map.__type);
      if (mapType.includes("ActivityFunctionMap")) {
        const activityId = text(map && map["ActivityId-"]);
        if (!ids.has(activityId) || seenActivityFunctions.has(activityId)) return true;
        seenActivityFunctions.add(activityId);
      } else if (mapType.includes("DeviceFunctionMap")) {
        if (!currentDeviceIds.has(text(map && map["DeviceId-"]))) return true;
      }
      return false;
    });
    state.config.functionList.FunctionMaps = originalFunctions.filter(
      (map) => !removedFunctions.includes(map)
    );

    const createdFunctions = [];
    activities().forEach((activity) => {
      if (activityFunctionMaps(objectId(activity)).length) return;
      const map = composeActivityFunctionMap(activity);
      functionMaps().push(map);
      createdFunctions.push(map);
    });
    return {
      changed:
        removed.length > 0 ||
        created.length > 0 ||
        removedFunctions.length > 0 ||
        createdFunctions.length > 0 ||
        clearedActivityActions.length > 0 ||
        repairedIdentifiers.length > 0 ||
        createdKeyboardRoles.length > 0 ||
        routedButtonActions > 0 ||
        createdKeyboardHidMaps.length > 0 ||
        removedKeyboardHidMaps.length > 0 ||
        prunedActionlessButtons > 0 ||
        sequenceRepair.cleared.length > 0 ||
        sequenceRepair.carried > 0 ||
        identityRepair.repairedMaps > 0,
      removed,
      created,
      removedFunctions,
      createdFunctions,
      clearedActivityActions,
      repairedIdentifiers,
      createdKeyboardRoles,
      routedButtonActions,
      createdKeyboardHidMaps,
      removedKeyboardHidMaps,
      repairedMapIdentities: identityRepair.repairedMaps,
      allocatedMapIds: identityRepair.allocatedMapIds,
      allocatedButtonIds: identityRepair.allocatedButtonIds,
      correctedButtonStates: identityRepair.correctedButtonStates,
      prunedActionlessButtons,
      clearedSequenceActions: sequenceRepair.cleared,
      carriedSequences: sequenceRepair.carried
    };
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
    markNotice("Loading local Harmony resources…");
    try {
      const config = await fetchJson("/api/activity-config");
      state.config = config;
      pictureStatus.checked = false;
      state.revision = text(config.revision);
      buildCommandCatalog();
      resetIdPool();
      const repair = reconcileActivityMaps();
      if (repair.changed) resetIdPool();
      const available = sortedActivities();
      if (!available.some((activity) => sameId(objectId(activity), state.selectedId))) {
        state.selectedId = available.length ? objectId(available[0]) : "";
      }
      state.selectedMap = 0;
      setDirty(repair.changed);
      renderAll();
      await refreshCurrentState(true);
      if (repair.changed) {
        const removed = repair.removed.length;
        const created = repair.created.length;
        const removedFunctions = repair.removedFunctions.length;
        const createdFunctions = repair.createdFunctions.length;
        const clearedActions = repair.clearedActivityActions.length;
        const repairedIdentifiers = repair.repairedIdentifiers.length;
        const createdKeyboardRoles = repair.createdKeyboardRoles.length;
        const routedButtonActions = repair.routedButtonActions;
        const createdKeyboardHidMaps = repair.createdKeyboardHidMaps.length;
        const removedKeyboardHidMaps = repair.removedKeyboardHidMaps.length;
        const allocatedMapIds = repair.allocatedMapIds;
        const allocatedButtonIds = repair.allocatedButtonIds;
        const correctedButtonStates = repair.correctedButtonStates;
        const prunedActionlessButtons = repair.prunedActionlessButtons;
        const clearedSequences = repair.clearedSequenceActions.map((entry) =>
          `${entry.button || "a button"} on ${entry.map} (sequence ${entry.sequenceId})`
        );
        const clearedSequenceNote = clearedSequences.length
          ? ` Cleared ${clearedSequences.length} press${clearedSequences.length === 1 ? "" : "es"} that ran a sequence the Hub doesn't have, so the button did nothing: ${clearedSequences.join(", ")}.`
          : "";
        markNotice(
          `Recovered an inconsistent Harmony graph: removed ${removed} stale button map${removed === 1 ? "" : "s"}, cleared ${clearedActions} stale activity shortcut${clearedActions === 1 ? "" : "s"}, corrected ${repairedIdentifiers} remote menu identifier${repairedIdentifiers === 1 ? "" : "s"}, added ${createdKeyboardRoles} Bluetooth keyboard role${createdKeyboardRoles === 1 ? "" : "s"}, routed ${routedButtonActions} missing remote action${routedButtonActions === 1 ? "" : "s"}, created ${createdKeyboardHidMaps} keyboard HID map${createdKeyboardHidMaps === 1 ? "" : "s"}, removed ${removedKeyboardHidMaps} stale keyboard HID map${removedKeyboardHidMaps === 1 ? "" : "s"}, created ${created} missing remote-surface map${created === 1 ? "" : "s"}, removed ${removedFunctions} stale control map${removedFunctions === 1 ? "" : "s"}, created ${createdFunctions} missing activity control map${createdFunctions === 1 ? "" : "s"}, issued ${allocatedMapIds} activity button map ID${allocatedMapIds === 1 ? "" : "s"} and ${allocatedButtonIds} physical button ID${allocatedButtonIds === 1 ? "" : "s"}, enabled ${correctedButtonStates} remote button${correctedButtonStates === 1 ? "" : "s"}, and dropped ${prunedActionlessButtons} action-less activity button${prunedActionlessButtons === 1 ? "" : "s"} that would leave the paired remote unresponsive.${clearedSequenceNote} Review and save this repair.`,
          "warn"
        );
      } else if (options.afterSave) {
        markNotice(options.afterSync
          ? "The Hub persisted all three activity resources, refreshed its paired-remote configuration revision locally, and reloaded the canonical result."
          : "The Hub persisted all three activity resources, reloaded its activity engine, and made the new local configuration available to paired remotes.");
      } else {
        markNotice(options.afterSync
          ? "The Hub refreshed its paired-remote configuration revision locally. The editor reloaded the resulting resources."
          : `Loaded ${available.length} activities, ${buttonMaps().length} button maps, and ${functionMaps().filter((map) => text(map && map.__type).includes("ActivityFunctionMap")).length} activity control maps.`);
      }
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
    if (isKeyboardHidActivityMap(map)) return "Keyboard HID";
    const prefix = activityMapRemotePrefix(map);
    const surface = map && (map["SurfaceId-"] ?? map["ButtonMapSurfaceId-"] ?? map.SurfaceId);
    const type = text(map && map.__type).replace("ButtonMap", "") || "Surface";
    if (prefix) return `${type} ${prefix}${surface == null ? "" : ` (${surface})`}`;
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
    const rawFunctions = byId("activityRawFunctions");
    if (rawActivity) rawActivity.value = JSON.stringify(activity, null, 2);
    if (rawMaps) rawMaps.value = JSON.stringify(activityMaps(objectId(activity)), null, 2);
    if (rawFunctions) {
      rawFunctions.value = JSON.stringify(
        activityFunctionMaps(objectId(activity))[0] || composeActivityFunctionMap(activity),
        null,
        2
      );
    }
  }

  // Activity icon on the remote (docs/REMOTE_PICTURES.md). The remote shows
  // the picture at <BaseImageUri><ImageKey>; the hub stores it and answers
  // that fetch. A new icon is drawn (a Material symbol on a colored tile) or
  // taken from an uploaded picture, sent to /api/activity-icon as a 70x70 PNG
  // and its 38x38 thumbnail, and its ImageKey goes into the activity with the
  // next save. The firmware Icon number is left alone.
  //
  // Material Icons by Google, Apache License 2.0 (third_party/material-icons);
  // the same path data as the shell's icons.js.
  const ICON_GLYPHS = [
    { key: "tv", label: "TV", d: "M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z" },
    { key: "movie", label: "Movie", d: "m18 4 2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" },
    { key: "sports_esports", label: "Game", d: "m21.58 16.09-1.09-7.66A3.996 3.996 0 0 0 16.53 5H7.47C5.48 5 3.79 6.46 3.51 8.43l-1.09 7.66a2.545 2.545 0 0 0 4.32 2.16L9 16h6l2.25 2.25c.48.48 1.13.75 1.8.75 1.56 0 2.75-1.37 2.53-2.91zM11 11H9v2H8v-2H6v-1h2V8h1v2h2v1zm4-1c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm2 3c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z" },
    { key: "music_note", label: "Music", d: "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" },
    { key: "speaker", label: "Speaker", d: "M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 1.99 2 1.99L17 22c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-5 2c1.1 0 2 .9 2 2s-.9 2-2 2a2 2 0 1 1 0-4zm0 16c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" },
    { key: "computer", label: "Computer", d: "M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z" },
    { key: "cast", label: "Streaming", d: "M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2a9 9 0 0 1 9 9h2c0-6.08-4.93-11-11-11z" },
    { key: "videocam", label: "Camera", d: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" },
    { key: "settings_input_hdmi", label: "HDMI input", d: "M18 7V4c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v3H5v6l3 6v3h8v-3l3-6V7h-1zM8 4h8v3h-2V5h-1v2h-2V5h-1v2H8V4z" },
    { key: "home", label: "Home", d: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" },
    { key: "settings_remote", label: "Remote", d: "M15 9H9c-.55 0-1 .45-1 1v12c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V10c0-.55-.45-1-1-1zm-3 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM7.05 6.05l1.41 1.41a5.022 5.022 0 0 1 7.08 0l1.41-1.41C15.68 4.78 13.93 4 12 4s-3.68.78-4.95 2.05zM12 0C8.96 0 6.21 1.23 4.22 3.22l1.41 1.41C7.26 3.01 9.51 2 12 2s4.74 1.01 6.36 2.64l1.41-1.41C17.79 1.23 15.04 0 12 0z" },
    { key: "play_arrow", label: "Play", d: "M8 5v14l11-7z" },
    { key: "bluetooth", label: "Bluetooth", d: "M17.71 7.71 12 2h-1v7.59L6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 11 14.41V22h1l5.71-5.71-4.3-4.29 4.3-4.29zM13 5.83l1.88 1.88L13 9.59V5.83zm1.88 10.46L13 18.17v-3.76l1.88 1.88z" },
    { key: "wifi", label: "Network", d: "m1 9 2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8 3 3 3-3a4.237 4.237 0 0 0-6 0zm-4-4 2 2a7.074 7.074 0 0 1 10 0l2-2C15.14 9.14 8.87 9.14 5 13z" },
    { key: "schedule", label: "Timer", d: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" }
  ];
  const ICON_COLORS = [
    { value: "#f26e21", label: "Orange" },
    { value: "#1e88e5", label: "Blue" },
    { value: "#43a047", label: "Green" },
    { value: "#8e24aa", label: "Purple" },
    { value: "#e53935", label: "Red" },
    { value: "#455a64", label: "Slate" }
  ];
  const ICON_SIZE = 70;
  const ICON_SMALL_SIZE = 38;
  // Any https host works: the hub answers Activity/<name>.png for every host.
  // A new activity has no BaseImageUri, so it gets this one.
  const ICON_BASE_URI = "https://images.melodious.invalid/";
  const iconChoice = { glyph: ICON_GLYPHS[0].key, color: ICON_COLORS[0].value, busy: false };

  function activityImageName(activity) {
    const match = /^Activity\/([A-Za-z0-9_-]{1,96})\.png$/.exec(text(activity && activity.ImageKey));
    return match && !match[1].endsWith("_small") ? match[1] : "";
  }

  // The square of a width x height picture that fills a tile (centered).
  function coverRect(width, height) {
    const side = Math.min(width, height);
    return { x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), side };
  }

  function roundedTile(g, size, color) {
    const r = size * 0.22;
    g.beginPath();
    g.moveTo(r, 0);
    g.arcTo(size, 0, size, size, r);
    g.arcTo(size, size, 0, size, r);
    g.arcTo(0, size, 0, 0, r);
    g.arcTo(0, 0, size, 0, r);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  }

  function glyphPng(size) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d");
    roundedTile(g, size, iconChoice.color);
    const glyph = ICON_GLYPHS.find((item) => item.key === iconChoice.glyph) || ICON_GLYPHS[0];
    const scale = (size * 0.62) / 24;
    g.translate((size - 24 * scale) / 2, (size - 24 * scale) / 2);
    g.scale(scale, scale);
    g.fillStyle = "#ffffff";
    g.fill(new Path2D(glyph.d));
    return canvas.toDataURL("image/png");
  }

  function picturePng(image, size) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d");
    const rect = coverRect(image.naturalWidth || image.width, image.naturalHeight || image.height);
    g.imageSmoothingQuality = "high";
    g.drawImage(image, rect.x, rect.y, rect.side, rect.side, 0, 0, size, size);
    return canvas.toDataURL("image/png");
  }

  function loadPicture(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("That file isn't a picture this browser can open."));
      };
      image.src = url;
    });
  }

  // Pictures the hub's activities and favorites use (GET /api/remote-pictures)
  // and the desktop app's recovery of the ones Logitech kept. Only the desktop
  // app can reach Logitech (window.melodiousDesktop.catalog.remotePicture);
  // the hub never fetches them itself.
  const pictureStatus = { checked: false, checking: false, busy: false, missing: 0, total: 0, message: "" };

  function desktopPictures() {
    const catalog = globalThis.melodiousDesktop && globalThis.melodiousDesktop.catalog;
    return catalog && typeof catalog.remotePicture === "function" ? catalog : null;
  }

  async function refreshPictureStatus() {
    if (pictureStatus.checking) return;
    pictureStatus.checking = true;
    try {
      const list = await fetchJson("/api/remote-pictures");
      pictureStatus.missing = Number(list.missing) || 0;
      pictureStatus.total = Number(list.total) || 0;
      pictureStatus.checked = true;
    } catch (_) {
      // An older hub without the route: say nothing.
      pictureStatus.checked = true;
      pictureStatus.missing = 0;
    } finally {
      pictureStatus.checking = false;
      renderIconField(selectedActivity());
    }
  }

  // The shell remembers which activity pictures the hub didn't have; tell it
  // when that may have changed (ui/shell.js listens).
  function picturesChanged() {
    try {
      document.dispatchEvent(new CustomEvent("melodious:pictures-changed"));
    } catch (_) {
      // No CustomEvent here (tests): nothing listens either.
    }
  }

  // POST pictures to the hub: the names it saved, and why for the others.
  // The hub refuses a whole request when one picture in it is bad, so a
  // refused batch is sent again one picture at a time.
  async function storePictures(batch) {
    const saved = [];
    const failed = new Map();
    try {
      const result = await fetchJson("/api/remote-pictures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pictures: batch })
      });
      for (const name of Array.isArray(result.saved) ? result.saved : []) saved.push(name);
      for (const item of Array.isArray(result.failed) ? result.failed : []) failed.set(item.name, item.error);
    } catch (error) {
      const reply = error.response && error.response.reply;
      if (error.status === 400 && batch.length > 1) {
        for (const picture of batch) {
          const one = await storePictures([picture]);
          saved.push(...one.saved);
          for (const [name, reason] of one.failed) failed.set(name, reason);
        }
      } else if (reply && Array.isArray(reply.failed) && reply.failed.length) {
        for (const item of reply.failed) failed.set(item.name, item.error);
      } else {
        for (const picture of batch) failed.set(picture.name, error.message);
      }
    }
    for (const picture of batch) {
      if (!saved.includes(picture.name) && !failed.has(picture.name)) failed.set(picture.name, "not saved");
    }
    return { saved, failed };
  }

  // Fetch every missing picture the hub lists through the desktop app and
  // store them in batches. Missing pictures come first in the hub's list;
  // asking again with the failures skipped (offset) reaches all of them.
  async function recoverPictures() {
    const catalog = desktopPictures();
    if (!catalog || pictureStatus.busy) return;
    pictureStatus.busy = true;
    pictureStatus.message = "";
    renderIconField(selectedActivity());
    const failed = new Map();
    let saved = 0;
    try {
      for (let round = 0; round < 200; round += 1) {
        const list = await fetchJson(`/api/remote-pictures?offset=${failed.size}`);
        const todo = (Array.isArray(list.pictures) ? list.pictures : [])
          .filter((picture) => picture && !picture.stored && picture.uri && !failed.has(picture.name));
        if (!todo.length) break;
        const batch = [];
        let size = 0;
        for (const picture of todo) {
          markNotice(`Fetching pictures from Logitech… ${saved + failed.size + batch.length + 1} of ${Number(list.missing) + saved || todo.length}`);
          try {
            const answer = await catalog.remotePicture({ uri: picture.uri, contentImageHost: list.contentImageHost || null });
            batch.push({ name: picture.name, image: answer.image });
            size += answer.image.length;
          } catch (error) {
            failed.set(picture.name, error.message);
          }
          if (batch.length >= 64 || size > 600 * 1024) break;
        }
        if (!batch.length) continue;
        const stored = await storePictures(batch);
        saved += stored.saved.length;
        for (const [name, reason] of stored.failed) failed.set(name, reason);
      }
      const reasons = [...new Set(failed.values())];
      pictureStatus.message = saved
        ? `Recovered ${saved} picture${saved === 1 ? "" : "s"}. Sync the remote to see them.`
        : "No pictures were recovered.";
      if (failed.size) {
        pictureStatus.message += ` ${failed.size} could not be recovered (${reasons.slice(0, 2).join("; ")}).`;
      }
      markNotice(pictureStatus.message, failed.size && !saved ? "warn" : "");
    } catch (error) {
      pictureStatus.message = `Recovering pictures stopped: ${error.message}`;
      markNotice(pictureStatus.message, "error");
    } finally {
      pictureStatus.busy = false;
      pictureStatus.checked = false;
      picturesChanged();
      await refreshPictureStatus();
    }
  }

  function pictureStatusHtml() {
    if (!pictureStatus.checked) return "";
    const lines = [];
    if (pictureStatus.missing > 0) {
      const what = `${pictureStatus.missing} of ${pictureStatus.total} pictures for the remote (activity icons and favorite channel logos) aren't on the hub.`;
      lines.push(desktopPictures()
        ? `<span>${esc(what)}</span><button type="button" class="btn btn-secondary secondary" data-icon-recover${pictureStatus.busy ? " disabled" : ""}>${pictureStatus.busy ? "Recovering…" : "Recover from Logitech"}</button>`
        : `<span>${esc(what)} Open the Melodious desktop app to recover them from Logitech.</span>`);
    }
    if (pictureStatus.message) lines.push(`<span>${esc(pictureStatus.message)}</span>`);
    return lines.length ? `<div class="activity-icon-recover">${lines.join("")}</div>` : "";
  }

  function renderIconField(activity) {
    const host = byId("activityIconField");
    if (!host) return;
    const name = activityImageName(activity);
    const glyphs = ICON_GLYPHS.map((item) => `<button type="button" class="activity-icon-glyph" data-icon-glyph="${esc(item.key)}" aria-pressed="${item.key === iconChoice.glyph}" title="${esc(item.label)}" aria-label="${esc(item.label)}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="${esc(item.d)}" fill="currentColor"/></svg></button>`).join("");
    const colors = ICON_COLORS.map((item) => `<button type="button" class="activity-icon-color" data-icon-color="${esc(item.value)}" aria-pressed="${item.value === iconChoice.color}" title="${esc(item.label)}" aria-label="${esc(item.label)}" style="--swatch:${esc(item.value)}"></button>`).join("");
    host.innerHTML = `
      <span class="activity-icon-label">Icon on the remote</span>
      <div class="activity-icon-row">
        <span class="activity-icon-preview">${name ? `<img src="/api/remote-pictures/image?name=${encodeURIComponent(name)}" alt="Current icon" width="${ICON_SIZE}" height="${ICON_SIZE}">` : ""}<span class="activity-icon-none"${name ? " hidden" : ""}>No icon</span></span>
        <div class="activity-icon-tools">
          <div class="activity-icon-glyphs" role="group" aria-label="Symbol">${glyphs}</div>
          <div class="activity-icon-colors" role="group" aria-label="Tile color">${colors}</div>
          <div class="activity-icon-actions">
            <button type="button" class="btn btn-secondary secondary" data-icon-use${iconChoice.busy ? " disabled" : ""}>Use this symbol</button>
            <label class="btn btn-secondary secondary activity-icon-upload">Upload picture…<input type="file" accept="image/*" data-icon-upload hidden${iconChoice.busy ? " disabled" : ""}></label>
            ${name ? `<button type="button" class="btn btn-secondary secondary" data-icon-remove${iconChoice.busy ? " disabled" : ""}>Remove icon</button>` : ""}
          </div>
          <p class="activity-icon-note" data-icon-note></p>
        </div>
      </div>
      ${pictureStatusHtml()}`;
    if (!pictureStatus.checked && !pictureStatus.checking) refreshPictureStatus();
    const preview = host.querySelector(".activity-icon-preview img");
    preview?.addEventListener("error", () => {
      preview.remove();
      const none = host.querySelector(".activity-icon-none");
      if (none) {
        none.hidden = false;
        none.textContent = "Not on the hub";
      }
      const note = host.querySelector("[data-icon-note]");
      if (note) {
        note.textContent = "This activity's icon was kept by Logitech and isn't on the hub. Recover it in the desktop app, or choose a new one.";
      }
    });
  }

  async function storeActivityIcon(image, thumbnail) {
    const activity = selectedActivity();
    if (!activity) return;
    const id = objectId(activity);
    iconChoice.busy = true;
    renderIconField(activity);
    markNotice("Storing the icon on the hub…");
    try {
      const result = await fetchJson("/api/activity-icon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, thumbnail })
      });
      const target = activities().find((item) => sameId(objectId(item), id));
      if (!target || typeof result.imageKey !== "string") throw new Error("The hub didn't return the icon's name.");
      target.ImageKey = result.imageKey;
      if (!text(target.BaseImageUri)) target.BaseImageUri = ICON_BASE_URI;
      touch(target);
      picturesChanged();
      markNotice("Icon stored on the hub. Save the activity, then sync the remote to see it.");
    } catch (error) {
      markNotice(`The icon wasn't stored: ${error.message}`, "error");
    } finally {
      iconChoice.busy = false;
      renderIconField(selectedActivity());
    }
  }

  function bindIconField() {
    const host = byId("activityIconField");
    if (!host) return;
    host.addEventListener("click", (event) => {
      const glyph = event.target.closest("[data-icon-glyph]");
      const color = event.target.closest("[data-icon-color]");
      if (glyph || color) {
        if (glyph) iconChoice.glyph = glyph.dataset.iconGlyph;
        if (color) iconChoice.color = color.dataset.iconColor;
        host.querySelectorAll("[data-icon-glyph]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.iconGlyph === iconChoice.glyph));
        });
        host.querySelectorAll("[data-icon-color]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.iconColor === iconChoice.color));
        });
        return;
      }
      if (event.target.closest("[data-icon-use]") && !iconChoice.busy) {
        storeActivityIcon(glyphPng(ICON_SIZE), glyphPng(ICON_SMALL_SIZE));
        return;
      }
      if (event.target.closest("[data-icon-recover]")) {
        recoverPictures();
        return;
      }
      if (event.target.closest("[data-icon-remove]") && !iconChoice.busy) {
        const activity = selectedActivity();
        if (!activity) return;
        activity.ImageKey = null;
        activity.BaseImageUri = null;
        touch(activity);
        renderIconField(activity);
        markNotice("Icon removed. Save the activity to apply it.");
      }
    });
    host.addEventListener("change", async (event) => {
      const input = event.target.closest("[data-icon-upload]");
      if (!input || !input.files || !input.files[0] || iconChoice.busy) return;
      try {
        const image = await loadPicture(input.files[0]);
        await storeActivityIcon(picturePng(image, ICON_SIZE), picturePng(image, ICON_SMALL_SIZE));
      } catch (error) {
        markNotice(error.message, "error");
      }
    });
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
    renderIconField(activity);
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
    if (field === "type") {
      role.__type = value;
      replaceActivityFunctionMap(activity);
    }
    if (field === "device") {
      const device = devices().find((item) => sameId(item.id, value));
      role["DeviceId-"] = device ? device.idValue : numericValue(value);
      role.SelectedInput = null;
      replaceActivityFunctionMap(activity);
      touch(activity);
      renderRoles(activity);
      return;
    }
    if (field === "input") {
      role.SelectedInput = value
        ? { ChannelNumber: null, "Id-": newButtonId(), Name: value }
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
      "Id-": newButtonId(),
      PowerOffOrder: order
    });
    replaceActivityFunctionMap(activity);
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
    replaceActivityFunctionMap(activity);
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

  function touchHardKey(buttonKey) {
    const key = buttonKey === "Dvr" ? "DVR" : text(buttonKey);
    const known = new Set(["Blue", "ChannelDown", "ChannelUp", "DVR", "DirectionDown", "DirectionLeft", "DirectionRight", "DirectionUp", "Exit", "FastForward", "Green", "Guide", "Info", "Menu", "Pause", "Play", "PrevChannel", "Record", "Red", "Rewind", "Select", "Stop", "VolumeDown", "VolumeMute", "VolumeUp", "Yellow"]);
    return known.has(key) ? key : "";
  }

  // P06 #1: a hard-key edit on 16414 must reach the Touch's own 16417 map.
  // The Touch answers hard keys from 16417 only. Mirror the edited key,
  // preserving the Touch button's ButtonId and key spelling (Dvr→DVR).
  function mirrorHardKeyToTouch(activityId, buttonKey, sourceButton, sourceMap) {
    const touchKey = touchHardKey(buttonKey);
    if (!touchKey) return;
    const touchMap = activityMaps(activityId).find((m) =>
      text(m && m.ButtonMapIdentifier) === `16417Activity${activityId}`);
    if (!touchMap || !Array.isArray(touchMap.Buttons)) return;
    const existing = touchMap.Buttons.find((b) =>
      text(b && b.__type).includes("HardRemoteButton") && text(b && b.ButtonKey) === touchKey);
    const hasAction = sourceButton && (sourceButton.ButtonAction || sourceButton.ButtonLongPressAction || sourceButton.ButtonDoublePressAction);
    if (!hasAction) {
      // Dropping a key on 16414 drops it on the Touch too (explicit remove).
      if (existing) {
        touchMap.Buttons = touchMap.Buttons.filter((b) => b !== existing);
        if (Object.prototype.hasOwnProperty.call(touchMap, "DateModified")) touchMap.DateModified = harmonyDate();
      }
      return;
    }
    // A sequence press keeps working on the Touch only if its sequence comes along.
    const mirrored = (field) => {
      const action = sourceButton[field];
      if (!action) return null;
      const copy = clone(action);
      return carrySequence(sourceMap, touchMap, copy) ? copy : null;
    };
    if (existing) {
      existing.ButtonAction = mirrored("ButtonAction");
      existing.ButtonLongPressAction = mirrored("ButtonLongPressAction");
      existing.ButtonDoublePressAction = mirrored("ButtonDoublePressAction");
      existing.FunctionGroupType = 0;
      existing.ButtonKey = touchKey;
      existing.ButtonState = 1;
    } else {
      touchMap.Buttons.push({
        ButtonId: newButtonId(),
        __type: "HardRemoteButton",
        ButtonAction: mirrored("ButtonAction"),
        ButtonDoublePressAction: mirrored("ButtonDoublePressAction"),
        FunctionGroupType: 0,
        ButtonState: 1,
        ButtonKey: touchKey,
        ButtonLongPressAction: mirrored("ButtonLongPressAction"),
      });
    }
    if (Object.prototype.hasOwnProperty.call(touchMap, "DateModified")) touchMap.DateModified = harmonyDate();
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
      // P06 #2: genuine soft presses use EventType 0 (hard keys use 1).
      const isTouchSoft = text(map && map.ButtonMapIdentifier).startsWith("16417")
        && text(button.__type).includes("SoftRemoteButton")
        && field === "ButtonAction";
      const eventType = field === "ButtonLongPressAction" ? 2 :
        field === "ButtonDoublePressAction" ? 3 : (isTouchSoft ? 0 : 1);
      button[field] = createAction(commandIndex, button[field], eventType);
    }
    // P06 #1: mirror 16414 hard-key edits to the Touch map.
    if (text(map && map.ButtonMapIdentifier).startsWith("16414Activity")
        && text(button.__type).includes("HardRemoteButton")) {
      mirrorHardKeyToTouch(objectId(activity), text(button.ButtonKey), button, map);
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

  function replaceIdentifier(value, oldActivityId, newActivityId, oldMapKey, newMapKey) {
    if (typeof value !== "string") return value;
    let next = value;
    if (oldActivityId) next = next.split(text(oldActivityId)).join(text(newActivityId));
    if (oldMapKey) next = next.split(text(oldMapKey)).join(text(newMapKey));
    return next;
  }

  function normalizeActivityMapIdentifiers(map, activityId) {
    if (!map || !activityId) return false;
    const id = text(activityId);
    let changed = false;
    const identifier = text(map.ButtonMapIdentifier);
    const identifierMatch = identifier.match(/Activity-?\d+$/);
    if (identifierMatch) {
      const expected = identifier.replace(/Activity-?\d+$/, `Activity${id}`);
      if (expected !== identifier) {
        map.ButtonMapIdentifier = expected;
        changed = true;
      }
    }
    if (Array.isArray(map.Buttons)) {
      map.Buttons.forEach((button) => {
        const menu = button && button.MenuItem;
        const menuName = text(menu && menu.MenuName);
        if (!/^Activity\.-?\d+$/.test(menuName)) return;
        const expected = `Activity.${id}`;
        if (menuName !== expected) {
          menu.MenuName = expected;
          changed = true;
        }
      });
    }
    return changed;
  }

  function cloneMapForActivity(sourceMap, oldActivityId, newActivityId, keepActions) {
    const map = clone(sourceMap);
    map["ActivityId-"] = numericValue(newActivityId);
    prepareNewMapIdentities(map);
    normalizeActivityMapIdentifiers(map, newActivityId);
    if (Object.prototype.hasOwnProperty.call(map, "DateModified")) map.DateModified = harmonyDate();
    if (keepActions) {
      // The copy keeps its sequence presses, so it keeps their sequences too.
      if (Array.isArray(sourceMap.Sequences)) map.Sequences = clone(sourceMap.Sequences);
      if (isActivityButtonMap(map)) pruneActionlessButtons(map);
    } else if (Array.isArray(map.Buttons)) {
      // The skeleton stays so backfillActivityButtonMaps can route actions into it;
      // pruneActionlessActivityButtons drops the rest, so it must run after routing.
      map.Buttons.forEach((button) => {
        button.ButtonAction = null;
        button.ButtonLongPressAction = null;
        button.ButtonDoublePressAction = null;
      });
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
        role["Id-"] = newButtonId();
        if (role.SelectedInput) role.SelectedInput["Id-"] = newButtonId();
      });
    }
    return activity;
  }

  function createActivity(duplicate) {
    if (!state.config) return;
    const source = selectedActivity() || sortedActivities()[0] || null;
    const oldId = source ? objectId(source) : "";
    const id = newButtonId();
    const activity = baselineActivity(source, id, duplicate);
    activities().push(activity);

    const sourceMaps = source ? activityMaps(oldId) : [];
    const templates = sourceMaps.length
      ? sourceMaps
      : buttonMaps().filter((map) => map && map["ActivityId-"] != null).slice(0, 2);
    templates.forEach((map) => {
      buttonMaps().push(cloneMapForActivity(map, map["ActivityId-"], id, duplicate));
    });
    if (duplicate) {
      const sourceFunctionMap = activityFunctionMaps(oldId)[0];
      if (sourceFunctionMap) {
        functionMaps().push(cloneFunctionMapForActivity(sourceFunctionMap, oldId, id));
      }
    }
    normalizeOrders();
    state.selectedId = text(id);
    state.selectedMap = 0;
    touch(activity);
    renderAll();
    markNotice(duplicate
      ? "Duplicated the activity, its roles, remote button maps, and control groups. Review the name and routing, then save."
      : "Created a blank activity using the paired remote’s surface templates. Add device roles and button actions; its control groups will be generated locally when you save.");
    byId("activityName").focus();
    byId("activityName").select();
  }

  function removeActivityFromGraph(id) {
    const beforeActivities = activities().length;
    const beforeMaps = buttonMaps().length;
    const beforeFunctions = functionMaps().length;
    state.config.activityList.Activities = activities().filter(
      (item) => !sameId(objectId(item), id)
    );
    state.config.mapList.ButtonMaps = buttonMaps().filter(
      (map) => !sameId(map && map["ActivityId-"], id)
    );
    state.config.functionList.FunctionMaps = functionMaps().filter((map) =>
      !(
        text(map && map.__type).includes("ActivityFunctionMap") &&
        sameId(map && map["ActivityId-"], id)
      )
    );
    const clearedActivityActions = clearOrphanedActivityActions();
    normalizeOrders();
    return {
      removedActivities: beforeActivities - activities().length,
      removedMaps: beforeMaps - buttonMaps().length,
      removedFunctions: beforeFunctions - functionMaps().length,
      clearedActivityActions
    };
  }

  function deleteActivity() {
    const activity = selectedActivity();
    if (!activity) return;
    const id = objectId(activity);
    if (sameId(id, state.currentId)) {
      markNotice("This activity is currently running. Switch activities or power off before deleting it.", "warn");
      return;
    }
    if (!window.confirm(`Delete “${activityName(activity)}” and all of its remote button and control maps?`)) return;
    const removed = removeActivityFromGraph(id);
    const next = sortedActivities()[0];
    state.selectedId = next ? objectId(next) : "";
    state.selectedMap = 0;
    setDirty(true);
    renderAll();
    const cleared = removed.clearedActivityActions.length;
    markNotice(
      `Activity removed from the working copy with ${removed.removedMaps} remote button map${removed.removedMaps === 1 ? "" : "s"}, ${removed.removedFunctions} control map${removed.removedFunctions === 1 ? "" : "s"}, and ${cleared} activity shortcut${cleared === 1 ? "" : "s"}. Save to apply the deletion to the Hub.`,
      "warn"
    );
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
    if (!state.config || !state.config.activityList || !state.config.mapList ||
        !state.config.functionList) {
      throw new Error("Activity resources are not loaded.");
    }
    if (!Array.isArray(state.config.activityList.Activities)) {
      throw new Error("ActivityList.Activities must be an array.");
    }
    if (!Array.isArray(state.config.mapList.ButtonMaps)) {
      throw new Error("MapList.ButtonMaps must be an array.");
    }
    if (!Array.isArray(state.config.functionList.FunctionMaps)) {
      throw new Error("FunctionList.FunctionMaps must be an array.");
    }
    const ids = new Set();
    const names = new Set();
    const deviceIds = new Set(devices().map((device) => device.id));
    const bluetoothKeyboardIds = new Set(
      devices()
        .filter((device) =>
          Number(device.raw && device.raw.Transport) === 32 &&
          device.raw.IsKeyboardAssociated !== false
        )
        .map((device) => device.id)
    );
    const mapIds = new Set();
    const mapIdentifiers = new Set();
    const buttonIds = new Set();
    const activitySurfaces = new Map();
    const activityFunctionCounts = new Map();
    const keyboardActivityIds = new Set();
    const keyboardHidCounts = new Map();
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
      const bluetoothRoleDevices = new Set();
      const keyboardRoleDevices = new Set();
      activity.Roles.forEach((role) => {
        const deviceId = text(role && role["DeviceId-"]);
        const roleType = text(role && role.__type);
        if (!deviceId) throw new Error(`Activity “${name}” has a role without a device ID.`);
        if (!deviceIds.has(deviceId)) {
          throw new Error(`Activity “${name}” references unavailable device ${deviceId}.`);
        }
        const selectedInput = text(role && role.SelectedInput && role.SelectedInput.Name);
        if (selectedInput && !inputNamesForDevice(deviceId).includes(selectedInput)) {
          throw new Error(
            `Activity “${name}” input “${selectedInput}” is not available on device ${deviceId}.`
          );
        }
        if (roleType.includes("KeyboardTextEntryActivityRole")) {
          keyboardRoleDevices.add(deviceId);
        } else if (bluetoothKeyboardIds.has(deviceId)) {
          bluetoothRoleDevices.add(deviceId);
        }
      });
      bluetoothRoleDevices.forEach((deviceId) => {
        if (!keyboardRoleDevices.has(deviceId)) {
          throw new Error(
            `Activity “${name}” uses Bluetooth keyboard device ${deviceId} without a KeyboardTextEntryActivityRole.`
          );
        }
      });
      if (keyboardRoleDevices.size > 0) keyboardActivityIds.add(id);
    });
    buttonMaps().forEach((map) => {
      const mapLabel = text(map && map.ButtonMapIdentifier) || mapId(map) || "unknown";
      const activityId = text(map && map["ActivityId-"]);
      if (activityId && activityId !== "-1" && !ids.has(activityId)) {
        throw new Error(`Button map ${mapLabel} references missing activity ${activityId}.`);
      }
      if (activityId && activityId !== "-1") {
        const identifier = text(map && map.ButtonMapIdentifier);
        const identifierActivity = identifier.match(/Activity(-?\d+)$/);
        if (isActivityButtonMap(map) && !identifierActivity) {
          throw new Error(`Button map ${mapLabel} must identify activity ${activityId} in its ButtonMapIdentifier.`);
        }
        if (identifierActivity && identifierActivity[1] !== activityId) {
          throw new Error(`Button map ${mapLabel} identifies activity ${identifierActivity[1]} but references ${activityId}.`);
        }
        if (isKeyboardHidActivityMap(map)) {
          keyboardHidCounts.set(activityId, (keyboardHidCounts.get(activityId) || 0) + 1);
        }
        const surface = activityMapSurfaceKey(map);
        if (!surface) throw new Error(`Activity ${activityId} has a button map without a remote surface.`);
        if (!isKeyboardHidActivityMap(map)) {
          if (!activitySurfaces.has(activityId)) activitySurfaces.set(activityId, new Set());
          if (activitySurfaces.get(activityId).has(surface)) {
            throw new Error(`Activity ${activityId} has more than one button map for remote surface ${surface}.`);
          }
          activitySurfaces.get(activityId).add(surface);
        }
      }
      const deviceId = text(map && map["DeviceId-"]);
      if (deviceId && !deviceIds.has(deviceId)) {
        throw new Error(`Button map ${mapLabel} references unavailable device ${deviceId}.`);
      }
      if (isActivityButtonMap(map) && !positiveId(map["ButtonMapId-"])) {
        throw new Error(
          `Activity button map ${text(map.ButtonMapIdentifier) || activityId || "unknown"} needs a positive ButtonMapId-.`
        );
      }
      const id = mapId(map);
      if (id && id !== "0") {
        if (mapIds.has(id)) throw new Error(`Button map ID ${id} is duplicated.`);
        mapIds.add(id);
      }
      const identifier = text(map && map.ButtonMapIdentifier);
      if (identifier) {
        if (mapIdentifiers.has(identifier)) {
          throw new Error(`Button map identifier ${identifier} is duplicated.`);
        }
        mapIdentifiers.add(identifier);
      }
      if (map && Array.isArray(map.Buttons)) {
        map.Buttons.forEach((button) => {
          if (activityId && activityId !== "-1") {
            const menuName = text(button && button.MenuItem && button.MenuItem.MenuName);
            const menuActivity = menuName.match(/^Activity\.(-?\d+)$/);
            if (menuActivity && menuActivity[1] !== activityId) {
              throw new Error(
                `Button map ${mapLabel} menu identifies activity ${menuActivity[1]} but references ${activityId}.`
              );
            }
          }
          const buttonId = positiveId(button && button.ButtonId);
          if (isActivityButtonMap(map)) {
            if (!buttonId) {
              throw new Error(
                `Button map ${mapLabel} has a button without a positive ButtonId.`
              );
            }
            if (buttonIds.has(text(buttonId))) {
              throw new Error(`Remote button ID ${buttonId} is duplicated.`);
            }
            buttonIds.add(text(buttonId));
          }
          const buttonState = Number(button.ButtonState);
          if (buttonState !== 0 && buttonState !== 1) {
            throw new Error(
              `Remote button ${buttonId || mapLabel} has ButtonState ${text(button.ButtonState) || "none"}; only 0 or 1 is valid.`
            );
          }
          const buttonType = text(button.__type);
          if ((buttonType.includes("HardRemoteButton") || buttonType.includes("GestureRemoteButton")) &&
              !text(button.ButtonKey).trim()) {
            throw new Error(`Remote button ${buttonId || mapLabel} is missing the ButtonKey the firmware dispatches on.`);
          }
          if (buttonType.includes("SoftRemoteButton") &&
              !Number.isSafeInteger(Number(button.MenuItem && button.MenuItem.IndexInMenu))) {
            throw new Error(`Remote button ${buttonId || mapLabel} is missing its MenuItem.IndexInMenu.`);
          }
          if (isActivityButtonMap(map) && !hasButtonAction(button)) {
            throw new Error(
              `Activity button map ${mapLabel} button ${buttonId} has no press, long-press, or double-press action; the paired remote stops responding when it starts an activity whose map contains one.`
            );
          }
          ACTION_FIELDS.forEach((field) => {
            const action = button && button[field];
            if (!action || typeof action !== "object") return;
            const actionDeviceId = text(action["DeviceId-"]);
            if (actionDeviceId && !deviceIds.has(actionDeviceId)) {
              throw new Error(
                `Button map ${mapLabel} ${field} references unavailable device ${actionDeviceId}.`
              );
            }
            const actionActivityId = text(action["ActivityId-"]);
            if (actionActivityId && actionActivityId !== "-1" && !ids.has(actionActivityId)) {
              throw new Error(
                `Button map ${mapLabel} ${field} references missing activity ${actionActivityId}.`
              );
            }
          });
        });
      }
    });
    functionMaps().forEach((map) => {
      if (!map || typeof map !== "object" || Array.isArray(map)) {
        throw new Error("FunctionList contains a non-object function map.");
      }
      const type = text(map.__type);
      if (type.includes("ActivityFunctionMap")) {
        const activityId = text(map["ActivityId-"]);
        if (!ids.has(activityId)) {
          throw new Error(`FunctionList references missing activity ${activityId || "unknown"}.`);
        }
        activityFunctionCounts.set(
          activityId,
          (activityFunctionCounts.get(activityId) || 0) + 1
        );
        const modeId = text(map.UIModeName).match(/(\d+)$/);
        if (modeId && modeId[1] !== activityId) {
          throw new Error(
            `Function map for activity ${activityId} identifies activity ${modeId[1]}.`
          );
        }
      } else if (type.includes("DeviceFunctionMap")) {
        const deviceId = text(map["DeviceId-"]);
        if (!deviceIds.has(deviceId)) {
          throw new Error(`FunctionList device map references unavailable device ${deviceId}.`);
        }
      } else {
        throw new Error(`FunctionList contains unknown map type “${type || "missing"}”.`);
      }
      if (!Array.isArray(map.FunctionGroups)) {
        throw new Error(`${type || "Function map"} is missing its FunctionGroups array.`);
      }
      map.FunctionGroups.forEach((group) => {
        if (!group || !Array.isArray(group.Functions)) {
          throw new Error(`${type || "Function map"} contains an invalid function group.`);
        }
        group.Functions.forEach((action) => {
          const deviceId = text(action && action["DeviceId-"]);
          if (!deviceId || !deviceIds.has(deviceId)) {
            throw new Error(
              `Control group “${text(group.Name) || "unnamed"}” references unavailable device ${deviceId || "unknown"}.`
            );
          }
        });
      });
    });
    ids.forEach((activityId) => {
      const count = activityFunctionCounts.get(activityId) || 0;
      if (count !== 1) {
        throw new Error(`Activity ${activityId} has ${count} control-group FunctionMaps; exactly one is required.`);
      }
    });
    const expectedSurfaces = new Set();
    activitySurfaces.forEach((surfaces) => surfaces.forEach((surface) => expectedSurfaces.add(surface)));
    ids.forEach((activityId) => {
      const surfaces = activitySurfaces.get(activityId) || new Set();
      expectedSurfaces.forEach((surface) => {
        if (!surfaces.has(surface)) {
          throw new Error(`Activity ${activityId} is missing remote surface ${surface}.`);
        }
      });
      const hidCount = keyboardHidCounts.get(activityId) || 0;
      if (keyboardActivityIds.has(activityId) && hidCount !== 1) {
        throw new Error(`Activity ${activityId} has ${hidCount} keyboard HID maps; exactly one is required.`);
      }
      if (!keyboardActivityIds.has(activityId) && hidCount !== 0) {
        throw new Error(`Activity ${activityId} has a keyboard HID map without a keyboard role.`);
      }
    });
    normalizeOrders();
  }

  async function saveActivities(syncRemote) {
    if (!state.config) return;
    const repair = reconcileActivityMaps();
    if (repair.changed) {
      resetIdPool();
      setDirty(true);
      renderAll();
    }
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
      ? "Saving locally and refreshing the paired-remote configuration revision…"
      : "Saving all three activity resources as one offline Hub transaction…");
    try {
      const response = await fetch("/api/activity-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseRevision: state.revision,
          syncRemote: !!syncRemote,
          activityList: state.config.activityList,
          mapList: state.config.mapList,
          functionList: state.config.functionList
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
      await loadActivities({ afterSave: true, afterSync: !!syncRemote });
    } catch (error) {
      if (error.status === 409 || (error.response && error.response.revision)) {
        markNotice("The Hub’s resources changed while this page was open. Reload before making another save.", "warn");
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
    markNotice("Refreshing the paired-remote configuration revision on the Hub…");
    try {
      await fetchJson("/api/activity-sync", { method: "POST" });
      await loadActivities({ afterSync: true });
    } catch (error) {
      markNotice(`Local remote refresh failed: ${error.message}`, "error");
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
    let previousFunctions = null;
    try {
      const nextActivity = JSON.parse(byId("activityRawActivity").value);
      const nextMaps = JSON.parse(byId("activityRawMaps").value);
      const nextFunctionMap = JSON.parse(byId("activityRawFunctions").value);
      if (!nextActivity || typeof nextActivity !== "object" || Array.isArray(nextActivity)) {
        throw new Error("Activity JSON must be an object.");
      }
      if (!Array.isArray(nextMaps)) throw new Error("Activity maps JSON must be an array.");
      if (!nextFunctionMap || typeof nextFunctionMap !== "object" || Array.isArray(nextFunctionMap)) {
        throw new Error("Activity FunctionMap JSON must be an object.");
      }
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
      if (!text(nextFunctionMap.__type).includes("ActivityFunctionMap") ||
          !sameId(nextFunctionMap["ActivityId-"], state.selectedId)) {
        throw new Error(`Activity FunctionMap must reference activity ${state.selectedId}.`);
      }
      activityIndex = activities().findIndex((item) => sameId(objectId(item), state.selectedId));
      previousActivity = state.config.activityList.Activities[activityIndex];
      previousMaps = state.config.mapList.ButtonMaps;
      previousFunctions = state.config.functionList.FunctionMaps;
      state.config.activityList.Activities[activityIndex] = nextActivity;
      state.config.mapList.ButtonMaps = buttonMaps()
        .filter((map) => !sameId(map && map["ActivityId-"], state.selectedId))
        .concat(nextMaps);
      state.config.functionList.FunctionMaps = functionMaps()
        .filter((map) => !(
          text(map && map.__type).includes("ActivityFunctionMap") &&
          sameId(map && map["ActivityId-"], state.selectedId)
        ))
        .concat([nextFunctionMap]);
      validateGraph();
      resetIdPool();
      touch(nextActivity);
      renderAll();
      markNotice("Advanced JSON applied to the working copy. Review it, then save.");
    } catch (error) {
      if (activityIndex >= 0 && previousActivity && previousMaps && previousFunctions) {
        state.config.activityList.Activities[activityIndex] = previousActivity;
        state.config.mapList.ButtonMaps = previousMaps;
        state.config.functionList.FunctionMaps = previousFunctions;
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
    bindIconField();
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

  if (globalThis.__HARMONY_ACTIVITY_TEST__) {
    globalThis.__HARMONY_ACTIVITY_TEST__.api = {
      state,
      resetIdPool,
      cloneMapForActivity,
      cloneFunctionMapForActivity,
      composeActivityFunctionMap,
      reconcileActivityMaps,
      clearOrphanedActivityActions,
      removeActivityFromGraph,
      pruneActionlessButtons,
      validateGraph,
      saveActivities,
      activityMapSurfaceKey,
      activityFunctionMaps,
      activityImageName,
      coverRect,
      ICON_GLYPHS,
      ICON_BASE_URI,
      storePictures
    };
    return;
  }

  bindUi();
  if ((location.hash || "").replace(/^#/, "") === "activities" || byId("view-activities")?.classList.contains("active")) {
    loadActivities();
  }
})();
