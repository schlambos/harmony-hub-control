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

  function activityMapSurfaceKey(map) {
    if (!map || typeof map !== "object") return "";
    if (isKeyboardHidActivityMap(map)) return "virtual|16420|ActivityButtonMap";
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
        typeof button[field] === "object"
      );
      if (match) return match[field];
    }
    return null;
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
          const action =
            findMappedButton(siblingMaps, map, button, field) ||
            findMappedButton(sourceDeviceMaps, map, button, field);
          if (!action) return;
          button[field] = clone(action);
          resetActionIdentities(button[field]);
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
    const map = {
      "ButtonMapId-": newMapId(),
      "ActivityId-": numericValue(objectId(activity)),
      Buttons: buttons,
      "ButtonMapSurfaceId-": source["ButtonMapSurfaceId-"] ?? source.ButtonMapSurfaceId,
      "RemoteId-": source["RemoteId-"] ?? source.RemoteId,
      __type: "ActivityButtonMap",
      ButtonMapIdentifier: `16420Activity${objectId(activity)}`,
      DateModified: harmonyDate(),
      Sequences: [],
      "SurfaceId-": source["SurfaceId-"] ?? source.SurfaceId
    };
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
        correctedButtonStates: 0
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
      if (!normalizeActivityMapIdentifiers(map, activityId)) return;
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
      correctedButtonStates: identityRepair.correctedButtonStates
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
        markNotice(
          `Recovered an inconsistent Harmony graph: removed ${removed} stale button map${removed === 1 ? "" : "s"}, cleared ${clearedActions} stale activity shortcut${clearedActions === 1 ? "" : "s"}, corrected ${repairedIdentifiers} remote menu identifier${repairedIdentifiers === 1 ? "" : "s"}, added ${createdKeyboardRoles} Bluetooth keyboard role${createdKeyboardRoles === 1 ? "" : "s"}, routed ${routedButtonActions} missing remote action${routedButtonActions === 1 ? "" : "s"}, created ${createdKeyboardHidMaps} keyboard HID map${createdKeyboardHidMaps === 1 ? "" : "s"}, removed ${removedKeyboardHidMaps} stale keyboard HID map${removedKeyboardHidMaps === 1 ? "" : "s"}, created ${created} missing remote-surface map${created === 1 ? "" : "s"}, removed ${removedFunctions} stale control map${removedFunctions === 1 ? "" : "s"}, created ${createdFunctions} missing activity control map${createdFunctions === 1 ? "" : "s"}, issued ${allocatedMapIds} activity button map ID${allocatedMapIds === 1 ? "" : "s"} and ${allocatedButtonIds} physical button ID${allocatedButtonIds === 1 ? "" : "s"}, and enabled ${correctedButtonStates} remote button${correctedButtonStates === 1 ? "" : "s"}. Review and save this repair.`,
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
    if (!keepActions && Array.isArray(map.Buttons)) {
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
      const activityId = text(map && map["ActivityId-"]);
      if (activityId && activityId !== "-1" && !ids.has(activityId)) {
        throw new Error(`Button map ${mapId(map) || "unknown"} references missing activity ${activityId}.`);
      }
      if (activityId && activityId !== "-1") {
        const identifier = text(map && map.ButtonMapIdentifier);
        const identifierActivity = identifier.match(/Activity(-?\d+)$/);
        if (isActivityButtonMap(map) && !identifierActivity) {
          throw new Error(`Button map ${identifier || mapId(map) || "unknown"} must identify activity ${activityId} in its ButtonMapIdentifier.`);
        }
        if (identifierActivity && identifierActivity[1] !== activityId) {
          throw new Error(`Button map ${mapId(map) || identifier} identifies activity ${identifierActivity[1]} but references ${activityId}.`);
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
        throw new Error(`Button map ${mapId(map) || "unknown"} references unavailable device ${deviceId}.`);
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
      if (map && Array.isArray(map.Buttons)) {
        map.Buttons.forEach((button) => {
          if (activityId && activityId !== "-1") {
            const menuName = text(button && button.MenuItem && button.MenuItem.MenuName);
            const menuActivity = menuName.match(/^Activity\.(-?\d+)$/);
            if (menuActivity && menuActivity[1] !== activityId) {
              throw new Error(
                `Button map ${mapId(map) || "unknown"} menu identifies activity ${menuActivity[1]} but references ${activityId}.`
              );
            }
          }
          const buttonId = positiveId(button && button.ButtonId);
          if (!buttonId) {
            throw new Error(
              `Button map ${mapId(map) || "unknown"} has a button without a positive ButtonId.`
            );
          }
          if (buttonIds.has(text(buttonId))) {
            throw new Error(`Remote button ID ${buttonId} is duplicated.`);
          }
          buttonIds.add(text(buttonId));
          const buttonState = Number(button.ButtonState);
          if (buttonState !== 0 && buttonState !== 1) {
            throw new Error(
              `Remote button ${buttonId} has ButtonState ${text(button.ButtonState) || "none"}; only 0 or 1 is valid.`
            );
          }
          const buttonType = text(button.__type);
          if ((buttonType.includes("HardRemoteButton") || buttonType.includes("GestureRemoteButton")) &&
              !text(button.ButtonKey).trim()) {
            throw new Error(`Remote button ${buttonId} is missing the ButtonKey the firmware dispatches on.`);
          }
          if (buttonType.includes("SoftRemoteButton") &&
              !Number.isSafeInteger(Number(button.MenuItem && button.MenuItem.IndexInMenu))) {
            throw new Error(`Remote button ${buttonId} is missing its MenuItem.IndexInMenu.`);
          }
          ACTION_FIELDS.forEach((field) => {
            const action = button && button[field];
            if (!action || typeof action !== "object") return;
            const actionDeviceId = text(action["DeviceId-"]);
            if (actionDeviceId && !deviceIds.has(actionDeviceId)) {
              throw new Error(
                `Button map ${mapId(map) || "unknown"} ${field} references unavailable device ${actionDeviceId}.`
              );
            }
            const actionActivityId = text(action["ActivityId-"]);
            if (actionActivityId && actionActivityId !== "-1" && !ids.has(actionActivityId)) {
              throw new Error(
                `Button map ${mapId(map) || "unknown"} ${field} references missing activity ${actionActivityId}.`
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
      validateGraph,
      activityMapSurfaceKey,
      activityFunctionMaps
    };
    return;
  }

  bindUi();
  if ((location.hash || "").replace(/^#/, "") === "activities" || byId("view-activities")?.classList.contains("active")) {
    loadActivities();
  }
})();
